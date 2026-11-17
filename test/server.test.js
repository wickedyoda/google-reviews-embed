import test from "node:test";
import assert from "node:assert/strict";
import { startServer, placePayload, PLACE_ID, PLACE_ID_2 } from "./helpers.js";

const BUSINESS = { "moms-originals": { placeId: PLACE_ID, label: "Moms Originals" } };

test("GET /healthz reports readiness and business count", async () => {
  const s = await startServer({ businesses: BUSINESS });
  try {
    const { status, body } = await s.json("/healthz");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.businesses, 1);
  } finally { await s.close(); }
});

test("GET /api/businesses lists slugs and labels only", async () => {
  const s = await startServer({
    businesses: {
      "moms-originals": { placeId: PLACE_ID, label: "Moms Originals" },
      "second-shop": { placeId: PLACE_ID_2, label: "Second Shop" },
    },
  });
  try {
    const { status, body } = await s.json("/api/businesses");
    assert.equal(status, 200);
    assert.deepEqual(body.businesses, [
      { slug: "moms-originals", label: "Moms Originals" },
      { slug: "second-shop", label: "Second Shop" },
    ]);
    assert.equal(JSON.stringify(body).includes(PLACE_ID), false, "place ids are not published");
  } finally { await s.close(); }
});

test("reviews are fetched live once, then served from cache", async () => {
  const fetcher = (() => {
    const calls = [];
    const fn = async (url, init) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => placePayload() }; };
    fn.calls = calls;
    return fn;
  })();

  const s = await startServer({ businesses: BUSINESS, fetcher });
  try {
    const first = await s.json("/api/reviews?business=moms-originals&limit=2");
    assert.equal(first.status, 200);
    assert.equal(first.body.source, "live");
    assert.equal(first.body.cached, false);
    assert.equal(first.body.business.slug, "moms-originals");
    assert.equal(first.body.business.label, "Moms Originals");
    assert.equal(first.body.reviews.length, 2);

    const second = await s.json("/api/reviews?business=moms-originals&limit=2");
    assert.equal(second.body.source, "cache");
    assert.equal(second.body.cached, true);
    assert.equal(fetcher.calls.length, 1, "upstream must not be called twice");
  } finally { await s.close(); }
});

test("each business caches independently", async () => {
  const fetcher = (() => {
    const calls = [];
    const fn = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => placePayload({ name: "Second" }) }; };
    fn.calls = calls;
    return fn;
  })();

  const s = await startServer({
    businesses: {
      "moms-originals": { placeId: PLACE_ID, label: "Moms Originals" },
      "second-shop": { placeId: PLACE_ID_2, label: "Second Shop" },
    },
    fetcher,
  });
  try {
    await s.json("/api/reviews?business=moms-originals");
    await s.json("/api/reviews?business=second-shop");
    assert.equal(fetcher.calls.length, 2, "one upstream call per business");
    const again = await s.json("/api/reviews?business=second-shop");
    assert.equal(again.body.source, "cache");
    assert.equal(fetcher.calls.length, 2);
  } finally { await s.close(); }
});

test("unknown business returns 404 with the available list", async () => {
  const s = await startServer({ businesses: BUSINESS });
  try {
    const { status, body } = await s.json("/api/reviews?business=nope");
    assert.equal(status, 404);
    assert.equal(body.error, "unknown_business");
    assert.deepEqual(body.available, ["moms-originals"]);
  } finally { await s.close(); }
});

test("raw ?place= is refused unless ALLOW_ANY_PLACE=1", async () => {
  const blocked = await startServer({ businesses: BUSINESS });
  try {
    const { status, body } = await blocked.json(`/api/reviews?place=${PLACE_ID}`);
    assert.equal(status, 403);
    assert.equal(body.error, "place_not_allowed");
  } finally { await blocked.close(); }

  const allowed = await startServer({ businesses: BUSINESS, env: { ALLOW_ANY_PLACE: "1" } });
  try {
    const { status, body } = await allowed.json(`/api/reviews?place=${PLACE_ID}`);
    assert.equal(status, 200);
    assert.match(body.business.slug, /^place-/);
  } finally { await allowed.close(); }
});

test("an invalid place id is rejected even when ALLOW_ANY_PLACE=1", async () => {
  const s = await startServer({ env: { ALLOW_ANY_PLACE: "1" } });
  try {
    const { status, body } = await s.json("/api/reviews?place=../../etc/passwd");
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_place_id");
  } finally { await s.close(); }
});

test("no business and no default place yields a helpful 400", async () => {
  const s = await startServer();
  try {
    const { status, body } = await s.json("/api/reviews");
    assert.equal(status, 400);
    assert.equal(body.error, "missing_business");
  } finally { await s.close(); }
});

test("limit is clamped to the API maximum", async () => {
  const s = await startServer({ businesses: BUSINESS });
  try {
    const { body } = await s.json("/api/reviews?business=moms-originals&limit=99");
    assert.ok(body.reviews.length <= 5);
  } finally { await s.close(); }
});

test("stale cache is served when the upstream fails", async () => {
  let clock = 1_700_000_000_000;
  let mode = "ok";
  const fetcher = async () => (mode === "ok"
    ? { ok: true, status: 200, json: async () => placePayload() }
    : { ok: false, status: 500, json: async () => ({ error: { status: "INTERNAL" } }) });

  const s = await startServer({
    businesses: BUSINESS,
    fetcher,
    now: () => clock,
    env: { CACHE_TTL_SECONDS: "60", CACHE_MAX_STALE_SECONDS: "86400" },
  });
  try {
    await s.json("/api/reviews?business=moms-originals"); // prime
    clock += 120_000;                                     // now stale
    mode = "fail";

    const { status, body } = await s.json("/api/reviews?business=moms-originals");
    assert.equal(status, 200);
    assert.equal(body.stale, true);
    assert.equal(body.source, "stale-cache");
    assert.equal(body.reviews.length > 0, true);
  } finally { await s.close(); }
});

test("upstream failure with no cache returns a gateway error", async () => {
  const s = await startServer({
    businesses: BUSINESS,
    fetcher: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  try {
    const { status, body } = await s.json("/api/reviews?business=moms-originals");
    assert.equal(status, 502);
    assert.equal(body.error, "upstream_error");
  } finally { await s.close(); }
});

test("rate limiting returns 429 once the window is exhausted", async () => {
  const s = await startServer({ businesses: BUSINESS, env: { RATE_LIMIT_PER_MINUTE: "2" } });
  try {
    assert.equal((await s.json("/api/reviews?business=moms-originals")).status, 200);
    assert.equal((await s.json("/api/reviews?business=moms-originals")).status, 200);
    const third = await s.json("/api/reviews?business=moms-originals");
    assert.equal(third.status, 429);
    assert.equal(third.body.error, "rate_limited");
    assert.ok(Number(third.headers.get("x-ratelimit-remaining")) === 0);
  } finally { await s.close(); }
});

test("the API key never appears in a response", async () => {
  const s = await startServer({ businesses: BUSINESS });
  try {
    const res = await s.get("/api/reviews?business=moms-originals");
    const text = await res.text();
    assert.equal(text.includes("test-key"), false);
  } finally { await s.close(); }
});

test("static assets and fallbacks behave", async () => {
  const s = await startServer({ businesses: BUSINESS });
  try {
    const js = await s.get("/embed.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    assert.match(await js.text(), /customElements\.define\("google-reviews"/);

    const css = await s.get("/widget.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const root = await s.get("/", { redirect: "manual" });
    assert.equal(root.status, 302);

    const missing = await s.get("/nope");
    assert.equal(missing.status, 404);

    const post = await s.get("/healthz", { method: "POST" });
    assert.equal(post.status, 405);
  } finally { await s.close(); }
});

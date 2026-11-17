import test from "node:test";
import assert from "node:assert/strict";
import {
  clampLimit, isValidPlaceId, normalizePlace, fetchReviews, buildUrl,
  PlacesError, MAX_REVIEWS, FIELD_MASK,
} from "../src/places.js";
import { PLACE_ID, placePayload, okFetcher } from "./helpers.js";

test("clampLimit always lands in 1..5", () => {
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit("3"), 3);
  assert.equal(clampLimit(99), MAX_REVIEWS);
  assert.equal(clampLimit("nonsense"), MAX_REVIEWS);
  assert.equal(clampLimit(-4), 1);
});

test("place-id validation rejects obvious junk", () => {
  assert.equal(isValidPlaceId(PLACE_ID), true);
  assert.equal(isValidPlaceId("abc"), false);
  assert.equal(isValidPlaceId("../../etc/passwd"), false);
  assert.equal(isValidPlaceId("has space"), false);
  assert.equal(isValidPlaceId(null), false);
});

test("buildUrl encodes and refuses invalid ids", () => {
  assert.equal(buildUrl(PLACE_ID), `https://places.googleapis.com/v1/places/${PLACE_ID}`);
  assert.throws(() => buildUrl("bad id"), PlacesError);
});

test("normalizePlace maps fields, drops textless reviews, caps at the limit", () => {
  const payload = placePayload({ count: 7 });
  payload.reviews.push({ rating: 4, authorAttribution: { displayName: "Rating only" } });

  const out = normalizePlace(payload, 3);
  assert.equal(out.name, "Moms Originals");
  assert.equal(out.rating, 4.8);
  assert.equal(out.userRatingCount, 137);
  assert.equal(out.googleMapsUri, "https://maps.google.com/?cid=1234567890");
  assert.equal(out.reviews.length, 3, "clamped to 3");
  assert.equal(out.reviews[0].author, "Person 1");
  assert.equal(out.reviews[0].rating, 5);
  assert.equal(out.reviews[0].relativeTime, "a month ago");
  assert.equal(out.reviews[0].text, "Review number 1");
  assert.ok(!out.reviews.some((r) => r.author === "Rating only"), "textless review dropped");
});

test("normalizePlace defaults limit to five", () => {
  assert.equal(normalizePlace(placePayload({ count: 9 })).reviews.length, MAX_REVIEWS);
});

test("fetchReviews sends the API key and field mask as headers, never in the URL", async () => {
  const fetcher = okFetcher();
  const out = await fetchReviews({ apiKey: "sekret", placeId: PLACE_ID, limit: 2, fetcher });

  assert.equal(fetcher.calls.length, 1);
  const { url, init } = fetcher.calls[0];
  assert.equal(init.headers["X-Goog-Api-Key"], "sekret");
  assert.equal(init.headers["X-Goog-FieldMask"], FIELD_MASK);
  assert.ok(!url.includes("sekret"), "key must not appear in the request URL");
  assert.equal(out.reviews.length, 2);
});

test("fetchReviews passes language and region as query params", async () => {
  const fetcher = okFetcher();
  await fetchReviews({ apiKey: "k", placeId: PLACE_ID, language: "en", region: "US", fetcher });
  const url = new URL(fetcher.calls[0].url);
  assert.equal(url.searchParams.get("languageCode"), "en");
  assert.equal(url.searchParams.get("regionCode"), "US");
});

test("fetchReviews maps upstream failures to PlacesError", async () => {
  const err = await fetchReviews({
    apiKey: "k", placeId: PLACE_ID,
    fetcher: async () => ({ ok: false, status: 500, json: async () => ({ error: { status: "INTERNAL" } }) }),
  }).catch((e) => e);
  assert.ok(err instanceof PlacesError);
  assert.equal(err.status, 502);
  assert.equal(err.code, "upstream_error");

  const notFound = await fetchReviews({
    apiKey: "k", placeId: PLACE_ID,
    fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  }).catch((e) => e);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.code, "place_not_found");
});

test("fetchReviews reports timeouts without leaking the key", async () => {
  const err = await fetchReviews({
    apiKey: "sekret", placeId: PLACE_ID,
    fetcher: async () => { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; },
  }).catch((e) => e);
  assert.equal(err.status, 504);
  assert.equal(err.code, "upstream_unreachable");
  assert.ok(!String(err.message).includes("sekret"));
});

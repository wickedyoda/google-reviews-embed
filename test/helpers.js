import { createServer as createHttpServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { FileCache } from "../src/cache.js";
import { BusinessRegistry } from "../src/businesses.js";
import { createApp } from "../src/server.js";

export const PLACE_ID = "ChIJN1t_tDeuEmsRUsoyG83frY4";
export const PLACE_ID_2 = "ChIJrTLr-GyuEmsRBfy61i59si0";

export function placePayload({ name = "Moms Originals", count = 7 } = {}) {
  return {
    displayName: { text: name },
    rating: 4.8,
    userRatingCount: 137,
    googleMapsUri: "https://maps.google.com/?cid=1234567890",
    reviews: Array.from({ length: count }, (_, i) => ({
      rating: 5 - (i % 2),
      text: { text: `Review number ${i + 1}`, languageCode: "en" },
      relativePublishTimeDescription: "a month ago",
      publishTime: "2026-10-01T12:00:00Z",
      authorAttribution: { displayName: `Person ${i + 1}`, photoUri: `https://example.test/p${i}.jpg` },
      googleMapsUri: `https://maps.google.com/review/${i}`,
    })),
  };
}

export function okFetcher(payload = placePayload()) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => payload };
  };
  fetcher.calls = calls;
  return fetcher;
}

export function failingFetcher({ status = 500, body = { error: { status: "INTERNAL" } } } = {}) {
  return async () => ({ ok: false, status, json: async () => body });
}

/** Boot a fully wired server on an ephemeral port. */
export async function startServer({
  fetcher = okFetcher(),
  env = {},
  businesses = { "moms-originals": { placeId: PLACE_ID, label: "Moms Originals" } },
  now,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gre-test-"));
  const config = loadConfig({
    GOOGLE_MAPS_API_KEY: "test-key",
    BUSINESSES_FILE: join(dir, "businesses.json"),
    CACHE_FILE: join(dir, "cache.json"),
    ...env,
  });
  const registry = new BusinessRegistry(businesses);
  const cache = new FileCache(config.cacheFile, now ? { now } : {});

  const app = createApp({ config, registry, cache, fetcher, logger: { error() {}, warn() {}, log() {} }, ...(now ? { now } : {}) });
  const server = createHttpServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    server,
    app,
    cache,
    config,
    registry,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    get(path, init) { return fetch(`${base}${path}`, init); },
    json(path, init) { return this.get(path, init).then((r) => r.json().then((body) => ({ status: r.status, body, headers: r.headers }))); },
  };
}

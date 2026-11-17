import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCache } from "../src/cache.js";

const tmp = () => mkdtemp(join(tmpdir(), "gre-cache-"));

test("fresh, stale and expired windows behave as configured", async () => {
  let t = 1_000_000;
  const cache = new FileCache(join(await tmp(), "c.json"), { now: () => t });

  cache.set("k", { reviews: [] }, new Date(t).toISOString());
  assert.equal(cache.lookup("k", { ttlSeconds: 100, maxStaleSeconds: 1000 }).fresh, true);

  t += 150_000; // past TTL, inside stale window
  const stale = cache.lookup("k", { ttlSeconds: 100, maxStaleSeconds: 1000 });
  assert.equal(stale.fresh, false);
  assert.equal(stale.ageSeconds, 150);

  t += 2_000_000; // past max stale
  assert.equal(cache.lookup("k", { ttlSeconds: 100, maxStaleSeconds: 1000 }), null);
});

test("unknown keys and malformed entries return null", async () => {
  const cache = new FileCache(join(await tmp(), "c.json"));
  assert.equal(cache.lookup("nope", { ttlSeconds: 10, maxStaleSeconds: 10 }), null);
  cache.set("bad", { x: 1 }, "not-a-date");
  assert.equal(cache.lookup("bad", { ttlSeconds: 10, maxStaleSeconds: 10 }), null);
});

test("save then load round-trips entries", async () => {
  const file = join(await tmp(), "nested", "c.json");
  const a = new FileCache(file);
  a.set("k", { value: 42 }, new Date(0).toISOString());
  await a.save();

  const b = await new FileCache(file).load();
  assert.equal(b.get("k").value.value, 42);
  assert.equal(b.size, 1);
});

test("a corrupt cache file surfaces instead of being silently ignored", async () => {
  const file = join(await tmp(), "broken.json");
  await writeFile(file, "{not json", "utf8");
  await assert.rejects(() => new FileCache(file).load());
});

test("a missing cache file is not an error", async () => {
  const cache = await new FileCache(join(await tmp(), "absent.json")).load();
  assert.equal(cache.size, 0);
});

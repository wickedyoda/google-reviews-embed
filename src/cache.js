import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Tiny JSON-file cache. Shopify-independent, restart-surviving, and deliberately
 * boring: one file, atomic rename on save.
 *
 * Google's Maps Platform terms allow storing Places content for at most 30 days,
 * so the TTL is capped by config (see config.js) and entries older than
 * `maxStaleSeconds` are never served.
 */
export class FileCache {
  #entries = new Map();
  #loaded = false;

  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
  }

  async load() {
    if (this.#loaded) return this;
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.entries) {
        for (const [k, v] of Object.entries(parsed.entries)) this.#entries.set(k, v);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // corrupt cache is fatal: we want to notice
    }
    this.#loaded = true;
    return this;
  }

  get(key) {
    return this.#entries.get(key) ?? null;
  }

  /** @returns {{value:any, ageSeconds:number, fresh:boolean} | null} */
  lookup(key, { ttlSeconds, maxStaleSeconds }) {
    const entry = this.get(key);
    if (!entry || typeof entry.fetchedAt !== "string") return null;
    const ageSeconds = Math.max(0, Math.floor((this.now() - Date.parse(entry.fetchedAt)) / 1000));
    if (Number.isNaN(ageSeconds)) return null;
    if (ageSeconds > maxStaleSeconds) return null;
    return { value: entry.value, ageSeconds, fresh: ageSeconds <= ttlSeconds };
  }

  set(key, value, fetchedAt = new Date(this.now()).toISOString()) {
    this.#entries.set(key, { fetchedAt, value });
  }

  get size() {
    return this.#entries.size;
  }

  async save() {
    const payload = JSON.stringify({ savedAt: new Date(this.now()).toISOString(), entries: Object.fromEntries(this.#entries) }, null, 2);
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, this.file); // atomic on POSIX
  }
}

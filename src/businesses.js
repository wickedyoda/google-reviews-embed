import { readFile } from "node:fs/promises";
import { isValidPlaceId } from "./places.js";

/**
 * Multi-business registry.
 *
 * Each configured business gets its own slug and therefore its own embed:
 *
 *   <google-reviews business="moms-originals"></google-reviews>
 *
 * The registry is deliberately an allowlist. Accepting arbitrary place IDs from
 * the browser would let any visitor spend your Places API quota on any business
 * on earth — so raw `?place=` is refused unless ALLOW_ANY_PLACE=1.
 *
 * Place IDs are public identifiers, not secrets, so businesses.json is safe to
 * commit. The API key never appears here.
 */

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class BusinessError extends Error {
  constructor(message, { slug } = {}) {
    super(message);
    this.name = "BusinessError";
    this.slug = slug;
  }
}

export function normalizeSlug(slug) {
  return String(slug ?? "").trim().toLowerCase();
}

export function validateBusiness(slug, raw) {
  const key = normalizeSlug(slug);
  if (!SLUG_RE.test(key)) {
    throw new BusinessError(`invalid slug ${JSON.stringify(slug)} (use a-z, 0-9 and single hyphens)`, { slug: key });
  }
  if (!raw || typeof raw !== "object") {
    throw new BusinessError(`business ${key} must be an object`, { slug: key });
  }
  const placeId = String(raw.placeId ?? "").trim();
  if (!isValidPlaceId(placeId)) {
    throw new BusinessError(`business ${key} has an invalid placeId`, { slug: key });
  }
  return {
    slug: key,
    placeId,
    label: String(raw.label ?? key).trim() || key,
    language: raw.language ? String(raw.language).trim() : undefined,
    region: raw.region ? String(raw.region).trim() : undefined,
  };
}

export class BusinessRegistry {
  constructor(entries, { source = "inline" } = {}) {
    this.source = source;
    this.#map = new Map();
    for (const [slug, raw] of Object.entries(entries ?? {})) {
      const business = validateBusiness(slug, raw);
      if (this.#map.has(business.slug)) {
        throw new BusinessError(`duplicate business slug ${business.slug}`, { slug: business.slug });
      }
      this.#map.set(business.slug, business);
    }
    if (this.#map.size === 0) throw new BusinessError("business registry is empty");
  }

  #map;

  get size() { return this.#map.size; }
  get(slug) { return this.#map.get(normalizeSlug(slug)) ?? null; }
  has(slug) { return this.#map.has(normalizeSlug(slug)); }
  /** Public listing — slugs and labels only, never API material. */
  list() { return [...this.#map.values()].map(({ slug, label }) => ({ slug, label })); }
  all() { return [...this.#map.values()]; }
}

export async function loadBusinesses(file) {
  const raw = await readFile(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BusinessError(`${file}: invalid JSON — ${err.message}`);
  }
  const entries = parsed?.businesses ?? parsed;
  return new BusinessRegistry(entries, { source: file });
}

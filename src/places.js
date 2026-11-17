/**
 * Google Places API (New) — Place Details.
 *
 *   GET https://places.googleapis.com/v1/places/{PLACE_ID}
 *   X-Goog-Api-Key: <key>
 *   X-Goog-FieldMask: displayName,rating,userRatingCount,reviews,googleMapsUri
 *
 * Billing notes (verified against Google's SKU documentation):
 *   - `reviews` bills at Place Details **Enterprise + Atmosphere** (the most
 *     expensive tier), `rating`/`userRatingCount` at Enterprise, `displayName`
 *     and `googleMapsUri` at Pro. So: one request, maximum cache lifetime.
 *
 * The API returns at most five reviews, which is why `limit` is clamped to 5.
 */

export const FIELD_MASK = "displayName,rating,userRatingCount,reviews,googleMapsUri";
export const MAX_REVIEWS = 5;
export const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places";

/** Place IDs are opaque URL-safe tokens, not UUIDs: letters, digits, `_`, `-`. */
const PLACE_ID_RE = /^[A-Za-z0-9_-]{5,300}$/;

export class PlacesError extends Error {
  constructor(message, { status = 502, code = "places_error" } = {}) {
    super(message);
    this.name = "PlacesError";
    this.status = status;
    this.code = code;
  }
}

export function isValidPlaceId(placeId) {
  return typeof placeId === "string" && PLACE_ID_RE.test(placeId);
}

export function clampLimit(limit, fallback = MAX_REVIEWS) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_REVIEWS, Math.max(1, Math.trunc(n)));
}

export function buildUrl(placeId) {
  if (!isValidPlaceId(placeId)) {
    throw new PlacesError("Invalid place id", { status: 400, code: "invalid_place_id" });
  }
  return `${PLACES_ENDPOINT}/${encodeURIComponent(placeId)}`;
}

/** Map Google's Place object into the small shape the widget renders. */
export function normalizePlace(raw, limit = MAX_REVIEWS) {
  if (!raw || typeof raw !== "object") {
    throw new PlacesError("Empty place payload");
  }
  const reviews = Array.isArray(raw.reviews) ? raw.reviews : [];
  const mapped = reviews
    .map((r) => {
      const text = r?.text?.text ?? r?.originalText?.text ?? "";
      const author = r?.authorAttribution?.displayName ?? "Google user";
      if (!text) return null; // rating-only reviews carry no quotable text
      return {
        author,
        authorUri: r?.authorAttribution?.uri ?? null,
        authorPhoto: r?.authorAttribution?.photoUri ?? null,
        rating: typeof r?.rating === "number" ? r.rating : null,
        text,
        relativeTime: r?.relativePublishTimeDescription ?? null,
        publishTime: r?.publishTime ?? null,
        googleMapsUri: r?.googleMapsUri ?? null,
      };
    })
    .filter(Boolean)
    .slice(0, clampLimit(limit));

  return {
    name: raw?.displayName?.text ?? null,
    rating: typeof raw?.rating === "number" ? raw.rating : null,
    userRatingCount: typeof raw?.userRatingCount === "number" ? raw.userRatingCount : null,
    googleMapsUri: raw?.googleMapsUri ?? null,
    reviews: mapped,
  };
}

export async function fetchReviews({
  apiKey,
  placeId,
  limit = MAX_REVIEWS,
  language,
  region,
  timeoutMs = 8000,
  fetcher = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new PlacesError("Missing API key", { status: 500, code: "missing_api_key" });

  const url = new URL(buildUrl(placeId));
  if (language) url.searchParams.set("languageCode", language);
  if (region) url.searchParams.set("regionCode", region);

  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Never surface the upstream URL (it can carry query copies of the key) or key itself.
    const reason = err?.name === "TimeoutError" ? "upstream timeout" : "upstream unreachable";
    throw new PlacesError(reason, { status: 504, code: "upstream_unreachable" });
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.status || body?.error?.message || "";
    } catch { /* non-JSON error body */ }
    throw new PlacesError(`Google Places returned ${response.status}${detail ? ` (${detail})` : ""}`, {
      status: response.status === 404 ? 404 : 502,
      code: response.status === 404 ? "place_not_found" : "upstream_error",
    });
  }

  const json = await response.json();
  return normalizePlace(json, limit);
}

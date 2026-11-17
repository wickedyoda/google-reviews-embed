/**
 * Environment-driven configuration. Nothing here ever leaves the server except
 * the values the public widget needs (none of which include the API key).
 */

export class ConfigError extends Error {}

const num = (raw, fallback, name, min, max) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
};

const bool = (raw, fallback = false) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

export const THIRTY_DAYS = 30 * 24 * 60 * 60;

export function loadConfig(env = process.env, { requireApiKey = true } = {}) {
  const apiKey = String(env.GOOGLE_MAPS_API_KEY ?? "").trim();
  const placeId = String(env.PLACE_ID ?? "").trim();

  if (requireApiKey && !apiKey) {
    throw new ConfigError("GOOGLE_MAPS_API_KEY is required (server-side only — never ship it to the browser)");
  }

  const cacheTtlSeconds = num(env.CACHE_TTL_SECONDS, 12 * 60 * 60, "CACHE_TTL_SECONDS", 60, THIRTY_DAYS);
  const cacheMaxStaleSeconds = num(env.CACHE_MAX_STALE_SECONDS, 7 * 24 * 60 * 60, "CACHE_MAX_STALE_SECONDS", 0, THIRTY_DAYS);

  return {
    apiKey,
    placeId, // optional single-business default; prefer the businesses registry
    port: num(env.PORT, 8787, "PORT", 1, 65535),
    cacheTtlSeconds,
    cacheMaxStaleSeconds,
    rateLimitPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 60, "RATE_LIMIT_PER_MINUTE", 1, 100000),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 8000, "REQUEST_TIMEOUT_MS", 500, 60000),
    allowedOrigin: String(env.ALLOWED_ORIGIN ?? "").trim(),
    allowedOrigins: String(env.ALLOWED_ORIGIN ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    cacheFile: String(env.CACHE_FILE ?? "data/reviews-cache.json").trim(),
    businessesFile: String(env.BUSINESSES_FILE ?? "businesses.json").trim(),
    allowAnyPlace: bool(env.ALLOW_ANY_PLACE, false),
    language: String(env.LANGUAGE ?? "").trim(),
    region: String(env.REGION ?? "").trim(),
  };
}

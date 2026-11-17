import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { loadConfig, ConfigError } from "./config.js";
import { FileCache } from "./cache.js";
import { loadBusinesses, BusinessError, normalizeSlug } from "./businesses.js";
import { fetchReviews, clampLimit, isValidPlaceId, PlacesError, MAX_REVIEWS } from "./places.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

const STATIC = new Map([
  ["/embed.js", { file: "embed.js", type: "text/javascript; charset=utf-8" }],
  ["/widget.css", { file: "widget.css", type: "text/css; charset=utf-8" }],
  ["/demo.html", { file: "demo.html", type: "text/html; charset=utf-8" }],
]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** Fixed-window limiter: enough to stop casual abuse without a dependency. */
function makeLimiter({ limit, windowMs = 60_000, now = () => Date.now() }) {
  const buckets = new Map();
  return function check(key) {
    const t = now();
    const bucket = buckets.get(key);
    if (!bucket || t >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: t + windowMs });
      return { allowed: true, remaining: limit - 1, resetAt: t + windowMs };
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  };
}

export function createApp({
  config,
  registry,
  cache,
  fetcher = globalThis.fetch,
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (!config) throw new Error("createApp requires a config object");
  if (!registry) throw new Error("createApp requires a business registry");
  const store = cache ?? new FileCache(config.cacheFile, { now });
  const limiter = makeLimiter({ limit: config.rateLimitPerMinute, now });

  const cacheKey = (business) =>
    ["v2", business.slug, business.placeId, business.language || "-", business.region || "-"].join("|");

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    }
    return {};
  }

  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    }

    if (path === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
        businesses: registry.size,
        uptimeSeconds: Math.round(process.uptime?.() ?? 0),
      });
    }

    // ---- business directory -------------------------------------------------
    if (path === "/api/businesses") {
      return sendJson(res, 200, { businesses: registry.list() }, corsHeaders(req));
    }

    // ---- reviews ------------------------------------------------------------
    if (path === "/api/reviews") {
      const ip = clientIp(req);
      const gate = limiter(ip);
      const rateHeaders = {
        "X-RateLimit-Limit": String(config.rateLimitPerMinute),
        "X-RateLimit-Remaining": String(gate.remaining),
        "X-RateLimit-Reset": String(Math.ceil(gate.resetAt / 1000)),
      };
      if (!gate.allowed) {
        return sendJson(res, 429, {
          error: "rate_limited",
          retryAfterSeconds: Math.ceil((gate.resetAt - now()) / 1000),
        }, { ...rateHeaders, ...corsHeaders(req) });
      }

      const businessParam = normalizeSlug(url.searchParams.get("business") || url.searchParams.get("slug") || "");
      const placeParam = String(url.searchParams.get("place") ?? "").trim();

      let business;
      if (businessParam) {
        business = registry.get(businessParam);
        if (!business) {
          return sendJson(res, 404, {
            error: "unknown_business",
            business: businessParam,
            available: registry.list().map((b) => b.slug),
          }, { ...rateHeaders, ...corsHeaders(req) });
        }
      } else if (placeParam) {
        // Arbitrary place IDs are refused by default: they would let any visitor
        // spend your Places quota on any business in the world.
        if (!config.allowAnyPlace) {
          return sendJson(res, 403, {
            error: "place_not_allowed",
            message: "This deployment only serves configured businesses. Use ?business=<slug>, or set ALLOW_ANY_PLACE=1.",
          }, { ...rateHeaders, ...corsHeaders(req) });
        }
        if (!isValidPlaceId(placeParam)) {
          return sendJson(res, 400, { error: "invalid_place_id" }, { ...rateHeaders, ...corsHeaders(req) });
        }
        business = { slug: `place-${placeParam.slice(0, 12)}`, placeId: placeParam, label: null,
                     language: config.language || undefined, region: config.region || undefined };
      } else if (config.placeId && isValidPlaceId(config.placeId)) {
        business = { slug: "default", placeId: config.placeId, label: null,
                     language: config.language || undefined, region: config.region || undefined };
      } else {
        return sendJson(res, 400, {
          error: "missing_business",
          message: "Pass ?business=<slug>. See /api/businesses for configured slugs.",
        }, { ...rateHeaders, ...corsHeaders(req) });
      }

      const limit = clampLimit(url.searchParams.get("limit"), MAX_REVIEWS);
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const key = cacheKey(business);

      const hit = forceRefresh ? null : store.lookup(key, {
        ttlSeconds: config.cacheTtlSeconds,
        maxStaleSeconds: config.cacheMaxStaleSeconds,
      });

      if (hit && hit.fresh) {
        return sendJson(res, 200, {
          business: { slug: business.slug, label: business.label },
          ...hit.value,
          reviews: hit.value.reviews.slice(0, limit),
          cached: true,
          ageSeconds: hit.ageSeconds,
          source: "cache",
        }, {
          ...rateHeaders,
          ...corsHeaders(req),
          "Cache-Control": `public, max-age=${Math.max(0, config.cacheTtlSeconds - hit.ageSeconds)}`,
        });
      }

      try {
        const fresh = await fetchReviews({
          apiKey: config.apiKey,
          placeId: business.placeId,
          limit,
          language: business.language || config.language,
          region: business.region || config.region,
          timeoutMs: config.requestTimeoutMs,
          fetcher,
        });
        store.set(key, fresh);
        store.save().catch((err) => logger.error?.(`[cache] save failed: ${err.message}`));
        return sendJson(res, 200, {
          business: { slug: business.slug, label: business.label },
          ...fresh,
          cached: false,
          ageSeconds: 0,
          source: "live",
        }, { ...rateHeaders, ...corsHeaders(req) });
      } catch (err) {
        const isPlaces = err instanceof PlacesError;
        const status = isPlaces ? err.status : 500;
        const code = isPlaces ? err.code : "internal_error";
        if (hit) {
          logger.warn?.(`[api] ${code} for ${business.slug}; serving ${hit.ageSeconds}s-old cache`);
          return sendJson(res, 200, {
            business: { slug: business.slug, label: business.label },
            ...hit.value,
            reviews: hit.value.reviews.slice(0, limit),
            cached: true,
            stale: true,
            ageSeconds: hit.ageSeconds,
            source: "stale-cache",
          }, { ...rateHeaders, ...corsHeaders(req), "Cache-Control": "no-store" });
        }
        logger.error?.(`[api] ${code} for ${business.slug}: ${err.message}`);
        return sendJson(res, status, { error: code, business: business.slug }, { ...rateHeaders, ...corsHeaders(req) });
      }
    }

    // ---- static widget assets ----------------------------------------------
    const asset = STATIC.get(path);
    if (asset) {
      try {
        const body = await readFile(join(PUBLIC_DIR, normalize(asset.file)));
        res.writeHead(200, {
          "Content-Type": asset.type,
          "Content-Length": body.length,
          "Cache-Control": "public, max-age=300",
          ...SECURITY_HEADERS,
        });
        return res.end(req.method === "HEAD" ? undefined : body);
      } catch {
        return sendJson(res, 500, { error: "asset_unavailable" });
      }
    }

    if (path === "/" || path === "/index.html") {
      res.writeHead(302, { Location: "/demo.html", ...SECURITY_HEADERS });
      return res.end();
    }

    return sendJson(res, 404, { error: "not_found" });
  }

  return { handler, store, limiter };
}

export function createServer(options) {
  const { handler } = createApp(options);
  return createHttpServer((req, res) => {
    handler(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error" }));
        } else {
          res.end();
        }
      } catch { /* socket already gone */ }
      options?.logger?.error?.(err);
    });
  });
}

// ---- entrypoint -----------------------------------------------------------
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  let registry;
  try {
    registry = await loadBusinesses(config.businessesFile);
  } catch (err) {
    if (err?.code === "ENOENT") {
      console.error(`config error: businesses file not found: ${config.businessesFile}`);
      console.error("  copy businesses.example.json → businesses.json and fill in place IDs");
      process.exit(2);
    }
    if (err instanceof BusinessError) {
      console.error(`config error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const cache = await new FileCache(config.cacheFile).load();
  const server = createServer({ config, registry, cache });

  server.listen(config.port, () => {
    console.log(`google-reviews-embed listening on :${config.port}`);
    console.log(`  businesses: ${registry.list().map((b) => b.slug).join(", ") || "(none)"}`);
    console.log(`  cache TTL: ${config.cacheTtlSeconds}s   allowAnyPlace: ${config.allowAnyPlace}`);
    console.log(`  demo: http://localhost:${config.port}/demo.html`);
    if (!config.allowedOrigins.length) console.log("  CORS: same-origin only (set ALLOWED_ORIGIN to embed cross-site)");
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(async () => {
        await cache.save().catch(() => {});
        process.exit(0);
      });
    });
  }
}

# google-reviews-embed

[![CI](https://github.com/wickedyoda/google-reviews-embed/actions/workflows/ci.yml/badge.svg)](https://github.com/wickedyoda/google-reviews-embed/actions/workflows/ci.yml)
[![Security](https://github.com/wickedyoda/google-reviews-embed/actions/workflows/security.yml/badge.svg)](https://github.com/wickedyoda/google-reviews-embed/actions/workflows/security.yml)
[![Publish container image](https://github.com/wickedyoda/google-reviews-embed/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/wickedyoda/google-reviews-embed/actions/workflows/docker-publish.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

A small, self-hosted service that fetches Google reviews **server-side** through the
[Places API (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)
and hands them to an embeddable web component. One deployment serves **any number of
businesses**, each with its own widget and its own cache.

- Zero runtime dependencies (Node's own `http` + `fetch`)
- API key never reaches the browser
- Aggressive caching, so a busy page costs one API call per cache window
- Ships as a multi-arch container image (`linux/amd64`, `linux/arm64`)

---

## Table of contents

1. [Why a proxy instead of calling Google from the page](#why-a-proxy)
2. [Features](#features)
3. [Architecture](#architecture)
4. [Requirements](#requirements)
5. [Quick start](#quick-start)
6. [Google Cloud setup](#google-cloud-setup)
7. [Configuration reference](#configuration-reference)
8. [The business registry](#the-business-registry)
9. [Embedding the widget](#embedding-the-widget)
10. [HTTP API](#http-api)
11. [Caching and cost](#caching-and-cost)
12. [Security model](#security-model)
13. [Deployment](#deployment)
14. [Operations and troubleshooting](#operations-and-troubleshooting)
15. [Development](#development)
16. [CI, CD and releases](#ci-cd-and-releases)
17. [Google policy notes](#google-policy-notes)
18. [Limitations](#limitations)
19. [Licence](#licence)

---

## Why a proxy

Calling the Places API from browser JavaScript requires shipping your API key to every
visitor, where it can be lifted from the page and billed to you. It also means a fresh
API call per page view.

This service keeps the key on the server, fetches once, and caches the result:

```
Your page  ──►  <google-reviews business="moms-originals">
                     │  GET /api/reviews?business=moms-originals&limit=3
                     ▼
                This service  ──► fresh cache?  ──yes──►  return cached reviews
                     │
                     └──no──►  Places API (New)  ──►  normalise  ──►  cache  ──►  return
```

## Features

- **Multi-business.** A JSON registry maps short slugs to Google place IDs; every slug
  gets its own endpoint, cache entry and widget.
- **Quota-safe by default.** Only configured businesses are served. A raw `?place=` is
  refused unless you explicitly opt in.
- **Caching with a stale fallback.** Fresh data is served from disk; if Google is down,
  a stale copy is served rather than an empty widget.
- **Per-IP rate limiting** and an optional CORS allowlist.
- **Shadow-DOM widget** with light/dark theming, lazy loading, star ratings and the
  required Google attribution. Review text is rendered with `textContent`, never HTML.
- **Container hardening.** Non-root UID 10001, package manager removed from the image,
  built-in healthcheck.
- **Scanned in CI.** CodeQL, Trivy (filesystem + image) and a committed-key guard run on
  every push — see [Security model](#security-model).

## Architecture

| Path | Responsibility |
|------|----------------|
| `src/places.js` | Places API (New) client, field mask, response normaliser, `PlacesError` |
| `src/businesses.js` | Registry loading, slug/place-ID validation, public listing |
| `src/cache.js` | JSON file cache with TTL, stale window, atomic writes |
| `src/config.js` | Environment parsing and validation (TTL capped at Google's 30 days) |
| `src/server.js` | Routing, rate limiting, CORS, security headers, static assets |
| `public/embed.js` | `<google-reviews>` custom element |
| `public/widget.css` | Widget styles and CSS custom properties |
| `public/demo.html` | Live demo that renders every configured business |

The upstream call is a single Place Details request:

```http
GET https://places.googleapis.com/v1/places/{PLACE_ID}
X-Goog-Api-Key: <GOOGLE_MAPS_API_KEY>
X-Goog-FieldMask: displayName,rating,userRatingCount,reviews,googleMapsUri
```

Google returns **at most five reviews** per place. That is an API limit, not a setting,
so `limit` is clamped to 5.

## Requirements

- **Docker** (recommended), or **Node.js 20 or newer** to run from source.
- A **Google Cloud project** with billing enabled and **Places API (New)** switched on.
- A **Google place ID** per business — [find one here](https://developers.google.com/maps/documentation/places/web-service/place-id).

## Quick start

### 1. Create the business registry

```bash
cp businesses.example.json businesses.json
```

Edit it and replace the placeholder place IDs:

```json
{
  "businesses": {
    "moms-originals": { "placeId": "ChIJ…", "label": "Moms Originals", "language": "en", "region": "US" }
  }
}
```

### 2. Configure the environment

```bash
cp .env.example .env
```

At minimum set `GOOGLE_MAPS_API_KEY`. If your site runs on a different origin from this
service, also set `ALLOWED_ORIGIN`.

### 3. Run it

**Docker Compose** (uses the published image):

```bash
docker compose up -d
docker compose logs -f
```

**Docker, one line:**

```bash
docker run -d --name google-reviews \
  -p 8787:8787 \
  -e GOOGLE_MAPS_API_KEY=your_key \
  -e ALLOWED_ORIGIN=https://your-site.com \
  -v "$PWD/businesses.json:/app/businesses.json:ro" \
  -v reviews-data:/app/data \
  ghcr.io/wickedyoda/google-reviews-embed:latest
```

**From source:**

```bash
npm test          # 36 tests, nothing to install
node src/server.js
```

### 4. Verify

```bash
curl -s http://localhost:8787/healthz
# {"ok":true,"businesses":1,"uptimeSeconds":3}

curl -s "http://localhost:8787/api/reviews?business=moms-originals&limit=2"
```

Then open <http://localhost:8787/demo.html>.

### 5. Embed

```html
<script src="https://reviews.example.com/embed.js" defer></script>
<google-reviews business="moms-originals" limit="3"></google-reviews>
```

## Google Cloud setup

The full walkthrough is in [`docs/SETUP-google-cloud.md`](docs/SETUP-google-cloud.md).
The short version:

1. Enable **Places API (New)** — *not* the legacy "Places API".
   <https://console.cloud.google.com/apis/library/places.googleapis.com>
2. Create an API key and restrict it:
   - **Application restrictions → IP addresses** — the public IP of this host
     (HTTP-referrer restrictions do not apply to server-side calls)
   - **API restrictions → Places API (New)**
3. Find place IDs with the [Place ID Finder](https://developers.google.com/maps/documentation/places/web-service/place-id)
   and put them in `businesses.json`.

Never put the key in `businesses.json`, in a page, or in this repository.

## Configuration reference

Everything is an environment variable, validated at startup — the process exits with
`config error: …` rather than running misconfigured.

| Variable | Default | Range / notes |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | — | **Required.** Server-side only. |
| `BUSINESSES_FILE` | `businesses.json` | Path to the registry. Missing file = startup error. |
| `PORT` | `8787` | 1–65535 |
| `CACHE_FILE` | `data/reviews-cache.json` | Created automatically; mount a volume here. |
| `CACHE_TTL_SECONDS` | `43200` (12 h) | 60 – 2592000 (30 days, Google's ceiling) |
| `CACHE_MAX_STALE_SECONDS` | `604800` (7 d) | 0 – 2592000. How long a stale copy may still be served if Google fails. |
| `ALLOWED_ORIGIN` | *(empty)* | Comma-separated origins allowed to call the API cross-site. Empty = same-origin only. |
| `RATE_LIMIT_PER_MINUTE` | `60` | 1 – 100000, per client IP (honours `X-Forwarded-For`). |
| `REQUEST_TIMEOUT_MS` | `8000` | 500 – 60000, upstream timeout. |
| `ALLOW_ANY_PLACE` | `0` | `1` permits raw `?place=<id>` requests. Leave off unless you mean it. |
| `LANGUAGE` | *(empty)* | Default `languageCode` for every business. |
| `REGION` | *(empty)* | Default `regionCode` for every business. |
| `PLACE_ID` | *(empty)* | Optional single-business fallback when no `?business=` is given. |

## The business registry

`businesses.json` is an **allowlist**. It is the only place a place ID may come from,
which is what stops a visitor spending your quota on arbitrary businesses.

```json
{
  "businesses": {
    "moms-originals": {
      "placeId": "ChIJ…",
      "label": "Moms Originals",
      "language": "en",
      "region": "US"
    },
    "second-shop": {
      "placeId": "ChIJ…",
      "label": "Second Shop"
    }
  }
}
```

Rules enforced at startup:

- **Slug** — lowercase letters, digits and single hyphens, 1–40 characters
  (`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`). Lookup is case-insensitive.
- **`placeId`** — required; must match `^[A-Za-z0-9_-]{5,300}$`.
- **`label`** — optional, defaults to the slug. Used as the widget heading and the
  Google attribution title.
- **`language` / `region`** — optional per-business overrides of the global defaults.

Adding a business is a two-step operation: append an entry, then restart the service or
redeploy. Cache entries are keyed by slug, so a new business starts cold while the
others keep their cached reviews.

Place IDs are public identifiers, so this file is safe to commit. API keys are not, and
never appear here.

## Embedding the widget

```html
<script src="https://reviews.example.com/embed.js" defer></script>

<google-reviews business="moms-originals" limit="3"></google-reviews>
<google-reviews business="second-shop" limit="4" theme="dark"></google-reviews>
```

Any number of widgets may share a page; they share the stylesheet and each fetches only
its own business.

### Attributes

| Attribute | Default | Description |
|---|---|---|
| `business` | — | Slug from `businesses.json`. The normal, quota-safe path. |
| `place-id` | — | Raw place ID. Only works when the server sets `ALLOW_ANY_PLACE=1`. |
| `endpoint` | origin of `embed.js` | Base URL of the service, if the widget is served from a CDN or another host. |
| `limit` | `5` | Reviews to render, 1–5. |
| `min-rating` | `0` | Hide reviews below this star rating. |
| `theme` | `auto` | `light`, `dark`, or `auto` (follows `prefers-color-scheme`). |
| `lazy` | `true` | `false` fetches immediately instead of waiting for scroll. |
| `heading` | business label | Heading text. `heading=""` hides it. |
| `show-count` | `true` | `false` hides the "N Google reviews" line. |

### Events

Both bubble from the element:

```js
document.querySelector("google-reviews").addEventListener("google-reviews:loaded", (e) => {
  console.log("loaded", e.detail.rating, e.detail.reviews.length);
});
document.querySelector("google-reviews").addEventListener("google-reviews:error", (e) => {
  console.warn("reviews unavailable", e.detail);
});
```

### Styling

The widget renders in shadow DOM and exposes `::part(root)`. Brand it with CSS custom
properties:

```css
google-reviews {
  --gre-font: "Inter", system-ui, sans-serif;
  --gre-radius: 10px;
  --gre-accent: #0b6b3a;
}
```

Internal theme variables (`--gre-bg`, `--gre-fg`, `--gre-muted`, `--gre-border`,
`--gre-star`) are set per theme; override them on `google-reviews[data-theme="light"]` or
`[data-theme="dark"]` for finer control.

### Cross-origin usage

If the page and this service are on **different** origins, set `ALLOWED_ORIGIN` to the
page origin (comma-separate several). Browsers send a simple `GET`, which needs only the
`Access-Control-Allow-Origin` response header — no preflight. If you add custom request
headers, note the server accepts only `GET`/`HEAD` and would reject an `OPTIONS`
preflight.

### Content-Security-Policy

If your page sets a CSP, allow the service origin:

```
script-src  'self' https://reviews.example.com;
style-src   'self' https://reviews.example.com;
connect-src 'self' https://reviews.example.com;
```

## HTTP API

All endpoints are `GET` (or `HEAD`). Responses are JSON unless noted.

### `GET /api/reviews`

| Parameter | Required | Description |
|---|---|---|
| `business` | yes* | Registry slug. `slug` is accepted as an alias. |
| `place` | — | Raw place ID; only when `ALLOW_ANY_PLACE=1`. Ignored if `business` is given. |
| `limit` | — | 1–5, default 5. Values outside the range are clamped. |
| `refresh` | — | `1` bypasses a *fresh* cache entry (still falls back to stale on failure). |

\* Unless `PLACE_ID` is configured as a default.

```json
{
  "business": { "slug": "moms-originals", "label": "Moms Originals" },
  "name": "Moms Originals",
  "rating": 4.8,
  "userRatingCount": 137,
  "googleMapsUri": "https://maps.google.com/?cid=…",
  "reviews": [
    {
      "author": "Alex Rivera",
      "authorUri": "https://www.google.com/maps/contrib/…",
      "authorPhoto": "https://lh3.googleusercontent.com/…",
      "rating": 5,
      "text": "…",
      "relativeTime": "a month ago",
      "publishTime": "2026-10-01T12:00:00Z",
      "googleMapsUri": "https://maps.google.com/…"
    }
  ],
  "cached": true,
  "ageSeconds": 431,
  "source": "cache"
}
```

`source` is `live` (fetched now), `cache` (fresh cache hit) or `stale-cache` (Google
failed, an old copy was served — also carries `"stale": true`).

### `GET /api/businesses`

```json
{ "businesses": [ { "slug": "moms-originals", "label": "Moms Originals" } ] }
```

Slugs and labels only — never place IDs, never keys.

### `GET /healthz`

```json
{ "ok": true, "businesses": 2, "uptimeSeconds": 137 }
```

Used by the container healthcheck; safe to point a monitor at.

### Static assets

| Path | Content type |
|---|---|
| `/embed.js` | `text/javascript` |
| `/widget.css` | `text/css` |
| `/demo.html` | `text/html` |

`/` redirects to `/demo.html`.

### Errors

Errors are `{"error": "<code>", …}` with a matching HTTP status:

| Status | `error` | Cause |
|---|---|---|
| 400 | `missing_business` | No `business` given and no `PLACE_ID` default. |
| 400 | `invalid_place_id` | Place ID fails format validation. |
| 403 | `place_not_allowed` | `?place=` used while `ALLOW_ANY_PLACE=0`. |
| 404 | `unknown_business` | Slug not in the registry (the response lists `available`). |
| 404 | `place_not_found` | Google does not know the place ID. |
| 405 | `method_not_allowed` | Anything other than `GET`/`HEAD`. |
| 429 | `rate_limited` | Per-IP limit exceeded; includes `retryAfterSeconds`. |
| 502 | `upstream_error` | Google returned an error. |
| 504 | `upstream_unreachable` | Timeout or network failure reaching Google. |
| 500 | `internal_error` | Unexpected failure. |

Every `/api/reviews` response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset` (epoch seconds).

## Caching and cost

Google bills per SKU, and the fields this service requests straddle three of them:

| Field | Place Details SKU |
|---|---|
| `reviews` | **Enterprise + Atmosphere** (the most expensive) |
| `rating`, `userRatingCount` | Enterprise |
| `displayName`, `googleMapsUri` | Pro |

A request bills at the highest SKU it touches, so every cache miss is an
Enterprise + Atmosphere call. The service therefore makes **one** call per business per
cache window, however many visitors the page receives.

- Default TTL 12 h → at most two calls per business per day.
- Raising `CACHE_TTL_SECONDS` lowers cost; Google permits storage up to 30 days.
- `CACHE_MAX_STALE_SECONDS` (default 7 days) is the safety net when Google is down.
- The cache is a single JSON file written atomically, so restarts keep their data.

Rough sizing: a 12-hour TTL across ten businesses is ~20 requests/day. Set a budget alert
and a quota cap in the Cloud console regardless.

## Security model

- **The API key never leaves the server.** It travels in an `X-Goog-Api-Key` header to
  Google — never in a URL, never in a response body. A unit test asserts the key cannot
  appear in a response.
- **The registry is an allowlist.** Arbitrary place IDs are refused, which prevents quota
  abuse by third parties.
- **Rate limiting** per client IP (default 60/min) with standard headers.
- **Security headers** on every response: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`.
- **CORS is opt-in** via `ALLOWED_ORIGIN`; without it, only same-origin callers work.
- **Input validation** on slugs and place IDs; user input is never interpolated into a
  URL path without encoding.
- **XSS-safe rendering.** Review bodies are third-party text inserted with `textContent`,
  so markup inside a review cannot execute.
- **Container hardening.** Runs as UID/GID 10001, `npm`/`npx`/`corepack` removed, no shell
  entrypoint, healthcheck built in.
- **Automated scanning.** CodeQL (`security-extended`), Trivy filesystem and image scans
  uploaded as SARIF, and a guard rejecting anything matching a Google API key pattern.
  Secret scanning and push protection are enabled on the repository.

## Deployment

### Docker Compose

`docker-compose.yml` is included and reads `.env`:

```bash
docker compose up -d
docker compose ps          # health status appears after the start period
docker compose logs -f
```

Set `HOST_PORT` in `.env` to change the published port; the container always listens on
8787 internally.

### Behind a reverse proxy

The service speaks plain HTTP on `PORT` and is happy behind nginx, Caddy or Traefik.
Terminate TLS at the proxy.

**nginx**

```nginx
server {
  listen 443 ssl http2;
  server_name reviews.example.com;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

**Caddy**

```
reviews.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Forward the real client IP (`X-Forwarded-For`) or every visitor will share one rate-limit
bucket.

### Volumes and backups

Only `/app/data` holds state (the review cache). Losing it costs one extra API call per
business — nothing else.

```yaml
volumes:
  - ./businesses.json:/app/businesses.json:ro   # config, read-only
  - reviews-data:/app/data                      # cache
```

### Upgrading

```bash
docker compose pull && docker compose up -d
```

Tags on GHCR: `latest`, `main`, `sha-<short>`, and semver (`1.2.3`, `1.2`) when a `v*`
tag is pushed. Pin `sha-…` in production if you want immutable deploys.

### Raspberry Pi / arm64

The image is published for `linux/amd64` and `linux/arm64`, so `docker pull` works
unchanged on a Pi 4/5 running a 64-bit OS.

## Operations and troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `403 place_not_allowed` | Request used `?place=` | Use `?business=<slug>`, or set `ALLOW_ANY_PLACE=1` |
| `404 unknown_business` | Slug typo | Check `/api/businesses` |
| `502 upstream_error` | Key restricted to another IP, Places API (New) not enabled, billing off, or field mask rejected | The container log line carries Google's status; verify key restrictions |
| `504 upstream_unreachable` | Timeout, DNS, or egress firewall | Raise `REQUEST_TIMEOUT_MS`; check egress to `places.googleapis.com` |
| `429 rate_limited` | Per-IP limit hit | Raise `RATE_LIMIT_PER_MINUTE`, or make your proxy forward `X-Forwarded-For` |
| Widget shows "Reviews are unavailable" | Fetch failed | Watch the `google-reviews:error` event; query the API directly |
| Widget shows "No reviews to show yet" | No text reviews, or `min-rating` filtered them | Lower `min-rating`; rating-only reviews carry no quotable text |
| Container `unhealthy` | Healthcheck failing | `docker logs <name>`; confirm `/healthz` from inside the network |
| Config error at startup | Missing `GOOGLE_MAPS_API_KEY` or a bad `businesses.json` | The message names the variable or the slug |

Logs are plain lines on stdout: a startup summary, `[api] <code> for <slug>: …`, and
`[cache] save failed: …`. Nothing sensitive is logged — no keys, no URLs containing keys.

## Development

```bash
npm test            # node --test — 36 tests, no dependencies to install
node --watch src/server.js
```

Layout:

```
src/          service code (ESM, no dependencies)
public/       widget: embed.js, widget.css, demo.html
test/         node:test suites + helpers
docs/         Google Cloud setup
.github/      CI, security and publish workflows, Dependabot config
```

The suite covers cache TTL/stale/expiry windows, place normalisation, slug and place-ID
validation, multi-business routing and caching, rate limiting, stale-on-error, error
mapping, and that the API key never appears in a response.

Local security scanning (the same tools CI uses):

```bash
docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:latest detect --source=/repo --no-banner
docker run --rm -v "$PWD:/src" aquasec/trivy:latest fs --scanners vuln,secret,misconfig /src
docker run --rm -v "$PWD:/src:ro" semgrep/semgrep:latest semgrep scan --config=p/nodejs --config=p/owasp-top-ten /src
```

## CI, CD and releases

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push, PR | Tests on Node 20 and 22; `node --check` on every JS file; JSON validation; runtime-artefact guard; Docker build + container smoke test against `/healthz` |
| `security.yml` | push, PR, weekly | CodeQL (javascript-typescript, `security-extended`); Trivy filesystem and image scans → SARIF; Google-key guard |
| `docker-publish.yml` | push to `main`, `v*` tags, manual | Builds `linux/amd64` + `linux/arm64` and pushes to GHCR with `latest`, `main`, `sha-<short>` and semver tags |

`main` is protected: every change goes through a pull request, linear history is
enforced, force pushes and deletions are blocked, and the rules apply to admins too.

Cutting a release:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

That publishes `ghcr.io/wickedyoda/google-reviews-embed:1.2.3`, `:1.2`, `:latest` (on the
default branch) and a `sha-…` tag.

## Google policy notes

Using Places content carries obligations — these shaped the implementation:

- **Five reviews maximum.** The API returns at most five reviews per place.
- **No modification.** Review text is displayed verbatim; the widget never rewrites,
  truncates or summarises it.
- **Attribution.** The Google mark and a link to the place are always rendered, and each
  review links back to Google.
- **Caching limit.** Places content may be stored for at most 30 days;
  `CACHE_TTL_SECONDS` is validated against that ceiling.
- **Terms.** You are responsible for complying with the
  [Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms)
  and the [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies).

## Limitations

- Five reviews per business — an API constraint, not a bug.
- No pagination, owner replies, or photo carry-through in the widget (the API exposes
  photos; rendering them was left out to keep the widget light).
- Rate limiting is in-process and per-instance; multiple replicas each keep their own
  counters.
- Business changes need a restart or redeploy — there is no live registry reload.
- The cache is per-instance on disk; replicas do not share it.

## Licence

MIT — see [LICENSE](LICENSE).

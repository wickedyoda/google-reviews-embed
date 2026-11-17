# google-reviews-embed

Fetch Google reviews **server-side** from the Places API (New) and embed them on any
site — one deployment, many businesses, each with its own widget.

**Why a proxy instead of calling Google from the browser?**
- The API key stays on the server. Shipping it to a page is how keys get scraped and billed to you.
- Reviews are cached, so a busy page does not bill you per visit.
- One endpoint serves any number of businesses by slug.

## How it works

```
browser  ──►  <google-reviews business="slug">  ──►  /api/reviews?business=slug
                                                        │
                                                        ├── cache (fresh?) ──► return
                                                        └── Google Places API (New) ──► normalise ──► cache ──► return
```

The Google call is a single Place Details request:

```
GET https://places.googleapis.com/v1/places/{PLACE_ID}
X-Goog-Api-Key: <GOOGLE_MAPS_API_KEY>
X-Goog-FieldMask: displayName,rating,userRatingCount,reviews,googleMapsUri
```

Google returns **at most five reviews** per place — that is an API limit, not a
configuration choice, so `limit` is clamped to 5.

## Quick start (Docker)

```bash
cp businesses.example.json businesses.json   # fill in your place IDs
docker run -d --name reviews \
  -p 8787:8787 \
  -e GOOGLE_MAPS_API_KEY=your_key \
  -e ALLOWED_ORIGIN=https://your-site.com \
  -v "$PWD/businesses.json:/app/businesses.json:ro" \
  -v reviews-cache:/app/data \
  ghcr.io/wickedyoda/google-reviews-embed:latest
```

Open `http://localhost:8787/demo.html`.

## Quick start (Node ≥ 20, no dependencies)

```bash
cp businesses.example.json businesses.json
cp .env.example .env          # then edit
export $(grep -v '^#' .env | xargs)
node src/server.js
```

## Businesses — one embed per business

`businesses.json`:

```json
{
  "businesses": {
    "moms-originals": {
      "placeId": "ChIJ...",
      "label": "Moms Originals",
      "language": "en",
      "region": "US"
    },
    "second-shop": {
      "placeId": "ChIJ...",
      "label": "Second Shop"
    }
  }
}
```

Every entry becomes its own widget, with its own cache entry and its own embed code:

```html
<script src="https://reviews.example.com/embed.js" defer></script>

<google-reviews business="moms-originals" limit="3"></google-reviews>
<google-reviews business="second-shop" limit="4" theme="dark"></google-reviews>
```

The registry is an **allowlist**. A raw `?place=<id>` is refused with `403` unless you
set `ALLOW_ANY_PLACE=1` — otherwise any visitor could spend your quota on any business
in the world.

Place IDs are public identifiers, so `businesses.json` is safe to commit. API keys are
not, and never appear in it.

## Widget attributes

| Attribute | Purpose |
|---|---|
| `business` | slug from `businesses.json` (normal, quota-safe path) |
| `place-id` | raw place ID — only with `ALLOW_ANY_PLACE=1` |
| `endpoint` | origin of the proxy (default: origin of `embed.js`) |
| `limit` | reviews to render, 1–5 (default 5) |
| `min-rating` | hide reviews below this star rating |
| `theme` | `light`, `dark`, `auto` (default `auto`) |
| `lazy` | `false` to fetch immediately instead of on scroll |
| `heading` | heading text; `""` hides it; omit to use the business label |
| `show-count` | `false` hides the “N Google reviews” line |

Events: `google-reviews:loaded` and `google-reviews:error` bubble from the element.

Styling: the widget renders in shadow DOM; `widget.css` uses CSS custom properties
(`--gre-accent`, `--gre-radius`, `--gre-font`) and exposes `::part(root)`.

## API

| Route | Description |
|---|---|
| `GET /api/reviews?business=<slug>&limit=1..5` | Reviews for one business |
| `GET /api/reviews?business=<slug>&refresh=1` | Bypass a *fresh* cache entry |
| `GET /api/businesses` | `[{slug,label}]` — never place IDs or keys |
| `GET /healthz` | `{ok:true,businesses:n}` |
| `GET /embed.js`, `/widget.css`, `/demo.html` | Widget assets |

A successful response:

```json
{
  "business": { "slug": "moms-originals", "label": "Moms Originals" },
  "name": "Moms Originals",
  "rating": 4.8,
  "userRatingCount": 137,
  "googleMapsUri": "https://maps.google.com/?cid=...",
  "reviews": [
    {
      "author": "Alex Rivera",
      "rating": 5,
      "text": "…",
      "relativeTime": "a month ago",
      "publishTime": "2026-10-01T12:00:00Z",
      "googleMapsUri": "https://maps.google.com/..."
    }
  ],
  "cached": true,
  "ageSeconds": 431,
  "source": "cache"          // live | cache | stale-cache
}
```

If Google fails and a cached copy exists, the service serves the stale copy
(`source: "stale-cache"`) rather than showing an empty widget.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | — | **required**, server-side only |
| `BUSINESSES_FILE` | `businesses.json` | registry path |
| `PORT` | `8787` | |
| `CACHE_FILE` | `data/reviews-cache.json` | |
| `CACHE_TTL_SECONDS` | `43200` (12 h) | max 30 days (Google's limit) |
| `CACHE_MAX_STALE_SECONDS` | `604800` (7 d) | stale fallback window |
| `ALLOWED_ORIGIN` | *(empty)* | comma-separated CORS origins; empty = same-origin only |
| `RATE_LIMIT_PER_MINUTE` | `60` | per client IP |
| `REQUEST_TIMEOUT_MS` | `8000` | upstream timeout |
| `ALLOW_ANY_PLACE` | `0` | allow raw `?place=` ids |
| `LANGUAGE`, `REGION` | *(empty)* | defaults for every business |

## Cost and caching

Google charges per SKU, and `reviews` sits in the most expensive Place Details tier
(**Enterprise + Atmosphere**); `rating`/`userRatingCount` are Enterprise, `displayName`
and `googleMapsUri` are Pro. That is why this service makes exactly **one** request per
business per cache window and never fetches per page view. See Google's
[SKU documentation](https://developers.google.com/maps/billing-and-pricing/sku-details/places).

Google's terms allow caching Places content for at most 30 days; the TTL is capped
accordingly in `src/config.js`.

## Google policy notes

- Review text must be displayed **unmodified** — this service never rewrites or
  truncates it, and the widget inserts it with `textContent` (never `innerHTML`).
- Attribution to Google is always rendered, and every review links back to Google.
- You are responsible for meeting the
  [Google Maps Platform Terms](https://cloud.google.com/maps-platform/terms) for your use.

## Development

```bash
npm test        # 36 tests, no dependencies to install — Node's built-in test runner
node --watch src/server.js
```

## Image

Published to GitHub Container Registry on every push to `main` and on `v*` tags:

```
ghcr.io/wickedyoda/google-reviews-embed:latest
ghcr.io/wickedyoda/google-reviews-embed:main
ghcr.io/wickedyoda/google-reviews-embed:sha-<short>   # immutable
ghcr.io/wickedyoda/google-reviews-embed:1.2.3        # from a v1.2.3 tag
```

Built for `linux/amd64` and `linux/arm64` (Raspberry Pi included).

## Licence

MIT

# Google Cloud setup

Everything here is one-time work in the Google Cloud console.

## 1. Project and billing

1. Create (or pick) a project at <https://console.cloud.google.com/>.
2. Enable billing for it. The Places API requires a billing account even if your
   usage stays inside the free tier.

## 2. Enable the right API

Enable **Places API (New)** — *not* the legacy "Places API".

<https://console.cloud.google.com/apis/library/places.googleapis.com>

Both may appear in the library. The legacy one is closed to new projects and this
service calls the `/v1/places/...` endpoint, which is the new API.

## 3. Create an API key

<https://console.cloud.google.com/apis/credentials> → **Create credentials → API key**

Then restrict it. A server-side key should be locked down hard:

- **Application restrictions → IP addresses**: add the public IP of the host running
  this service. (HTTP-referrer restrictions do not work for server-side calls.)
- **API restrictions → Restrict key → Places API (New)**.

Never place this key in a page, a repo, or `businesses.json`.

## 4. Find place IDs

Use the **Place ID Finder**:
<https://developers.google.com/maps/documentation/places/web-service/place-id>

Search the business, copy the `ChIJ...` value, and add it to `businesses.json` under a
slug of your choosing:

```json
{
  "businesses": {
    "moms-originals": { "placeId": "ChIJ...", "label": "Moms Originals" }
  }
}
```

Add as many businesses as you like — each gets its own cache entry and its own embed.

## 5. Verify it works

```bash
curl -s "http://localhost:8787/api/reviews?business=moms-originals&limit=3" | head -c 400
```

A `403` with `error: place_not_allowed` means you sent `?place=` instead of
`?business=` (expected — that guard protects your quota).
A `502` usually means the key restriction does not match this host's IP, the API is
not enabled, or billing is not set up.

## Cost control

- `reviews` bills in the highest Place Details SKU. One request per business per
  `CACHE_TTL_SECONDS` is the cheapest sensible configuration; raising the TTL lowers
  cost (Google permits up to 30 days).
- Keep `ALLOW_ANY_PLACE=0` unless you genuinely need arbitrary places. Otherwise
  strangers can spend your quota.
- Set a budget alert and a quota cap on the Places API in the Cloud console.

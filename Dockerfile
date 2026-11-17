# syntax=docker/dockerfile:1
# Zero runtime dependencies: no npm install, no build stage needed.
FROM node:22-alpine

LABEL org.opencontainers.image.title="google-reviews-embed" \
      org.opencontainers.image.description="Self-hosted Google reviews proxy and embeddable widget" \
      org.opencontainers.image.source="https://github.com/wickedyoda/google-reviews-embed" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8787 \
    CACHE_FILE=/app/data/reviews-cache.json

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY businesses.example.json ./

# Run unprivileged; the cache lives in a volume-backed directory.
RUN addgroup -g 10001 -S app \
 && adduser -u 10001 -S -G app app \
 && mkdir -p /app/data \
 && chown -R app:app /app

USER app
VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

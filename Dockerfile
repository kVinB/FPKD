# syntax=docker/dockerfile:1
FROM node:22.13.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY shared ./shared
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js ./
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION
RUN npm run build \
  && npm prune --omit=dev

FROM node:22.13.1-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SEIZURE_DIARY_DB_PATH=/data/seizure-diary.sqlite3 \
    WEB_DIST=/app/dist/web
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]

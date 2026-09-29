# syntax=docker/dockerfile:1

# ---- build the web app (PWA)
FROM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY shared ./shared
COPY web ./web
RUN npm run build

# ---- Whisper models for on-device voice input (pinned revisions, SHA-256 checked)
FROM node:24-alpine AS models
WORKDIR /app
COPY package.json ./
COPY server/voice-models.ts ./server/
COPY scripts/fetch-models.ts ./scripts/
RUN MODELS_DIR=/app/models node scripts/fetch-models.ts

# ---- production dependencies only
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime: TypeScript runs natively (Node type stripping), no build step, no native modules
FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist \
    MODELS_DIR=/app/models \
    PORT=8080
WORKDIR /app
COPY --from=models /app/models ./models
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY --from=web /app/dist ./dist
RUN mkdir -p /data && chown 568:568 /data
# TrueNAS "apps" user; override with `user:` in compose if needed.
USER 568:568
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.ts"]

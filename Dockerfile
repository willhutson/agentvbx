# ─── Build Stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/providers/package.json packages/providers/
COPY packages/api/package.json packages/api/
COPY packages/whatsapp/package.json packages/whatsapp/
COPY packages/voice/package.json packages/voice/
COPY packages/agent-browser/package.json packages/agent-browser/
COPY packages/integrations/package.json packages/integrations/

RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY config/ config/
COPY recipes/ recipes/

RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ─── Runtime Stage ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app

# Copy built application
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/*/dist ./packages/
COPY --from=builder /app/packages/*/package.json ./packages/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/config ./config
COPY --from=builder /app/recipes ./recipes

# Copy the desktop HTML for the API to serve
COPY packages/desktop/index.html ./packages/desktop/

# Non-root user
RUN addgroup -g 1001 -S agentvbx && \
    adduser -S agentvbx -u 1001 -G agentvbx && \
    mkdir -p /app/data/tenants && \
    chown -R agentvbx:agentvbx /app

USER agentvbx

ENV NODE_ENV=production
ENV API_PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/api/dist/index.js"]

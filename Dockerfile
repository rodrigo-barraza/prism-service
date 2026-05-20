# ============================================================
# Prism — Multi-stage Dockerfile
# ============================================================
# AI Gateway — Express server with streaming, WebSocket, and
# multi-provider routing. Uses boot.js to fetch secrets from
# Vault at startup.
# ============================================================

# ── Stage 1: Install dependencies ─────────────────────────────
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache git
RUN npm ci

# ── Stage 2: Build TypeScript ─────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN rm -rf dist && npm run build
# Prune devDependencies for the runtime image
RUN npm prune --omit=dev

# ── Stage 3: Runtime ──────────────────────────────────────────
FROM node:26-alpine
WORKDIR /app

# ffmpeg is required for GIF compression and video frame extraction
RUN apk add --no-cache ffmpeg

# Copy pre-built node_modules from deps stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Root-level JS files imported by dist/ via ../config.js
COPY --from=build /app/dist/config.js ./config.js

# Non-root user for security
RUN addgroup --system --gid 1001 prism && \
    adduser --system --uid 1001 prism
USER prism

EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:7777/health || exit 1

CMD ["node", "dist/boot.js"]

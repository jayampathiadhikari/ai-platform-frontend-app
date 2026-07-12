# =============================================================================
# Monitor — Next.js Dockerfile
# =============================================================================
# Multi-stage:
#   builder  — installs deps + runs next build
#   runtime  — serves with next start (minimal image)
# =============================================================================

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# Use npm install instead of npm ci to avoid cross-platform lockfile divergence
# (Windows-generated lockfile vs Alpine linux resolving different native binaries)
RUN npm install

COPY . .

# next build needs AGENT_URL at build time only if it's baked in;
# we pass it at runtime via env, so just build normally.
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Compiled Next.js output
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

CMD ["./node_modules/.bin/next", "start", "-p", "3001"]

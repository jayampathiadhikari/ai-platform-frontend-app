# =============================================================================
# Agent Container — Dockerfile
# =============================================================================
# Multi-stage build:
#   Stage 1 (builder): installs all deps + compiles TypeScript → dist/
#   Stage 2 (runtime): copies only dist/ + prod node_modules, minimal surface
#
# Build: docker build -t deepagent-agent -f deploy/agent/Dockerfile .
# =============================================================================

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps first (layer-cached unless package.json changes)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# git is needed by the workspace-manager (gitClone, gitPush, etc.)
RUN apk add --no-cache git

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Workspace jobs will be mounted here (ECS volume / local bind mount)
RUN mkdir -p /workspace/jobs

# Expose HTTP API port
EXPOSE 3000

# Run compiled entry point
CMD ["node", "dist/index.js"]

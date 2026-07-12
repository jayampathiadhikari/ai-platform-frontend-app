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

# Workspace jobs will be mounted here at runtime (ECS volume / local bind mount).
# The directory is created here so the image has the path; actual permissions are
# fixed at container startup by entrypoint.sh (volume mounts override image layers).
RUN mkdir -p /workspace/jobs

# Entrypoint fixes /workspace/jobs permissions at startup, then execs node
COPY src/langchain/deepagent/deploy/agent/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose HTTP API port
EXPOSE 3000

# Runs as root so it can git-clone into the shared volume and fix permissions.
# The entrypoint chmods /workspace/jobs then execs the node process.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]

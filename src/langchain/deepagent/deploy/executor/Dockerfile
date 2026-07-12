# =============================================================================
# Executor Sidecar — Dockerfile
# =============================================================================
# Minimal execution environment for agent-issued bash commands.
#
# Security by design:
#   - No AWS CLI, no credential helpers
#   - No AWS environment variables injected (controlled by ECS task def / compose)
#   - Runs as non-root user (node)
#   - Only tools a dev agent legitimately needs: git, node, npm, python3
#   - Listens only on 127.0.0.1 (localhost) — not externally reachable
#
# Build: docker build -t deepagent-executor -f deploy/executor/Dockerfile .
#        (run from repo root so COPY has access to deploy/executor/)
# =============================================================================

FROM node:22-alpine

# Install only the tools a dev agent needs — nothing more
RUN apk add --no-cache \
    git \
    python3 \
    py3-pip \
    bash \
    curl \
    # build tools needed by some npm packages
    make \
    g++ \
    # clean up
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy executor source
COPY deploy/executor/package.json ./
COPY deploy/executor/tsconfig.json ./
COPY deploy/executor/server.ts ./

# Install dev deps (only typescript + tsx — no prod deps)
RUN npm install

# Compile TypeScript → server.js
RUN npx tsc

# Workspace jobs directory — must match the agent container's mount point
RUN mkdir -p /workspace/jobs

# Run as non-root (node user is built into the node:alpine image)
USER node

# Only expose to localhost — the agent talks to us over 127.0.0.1:8080
EXPOSE 8080

CMD ["node", "server.js"]

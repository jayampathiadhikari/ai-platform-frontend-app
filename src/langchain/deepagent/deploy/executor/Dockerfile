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
# Build: docker build -t deepagent-executor -f src/langchain/deepagent/deploy/executor/Dockerfile .
#        (run from repo root so COPY has access to src/langchain/deepagent/deploy/executor/)
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
COPY src/langchain/deepagent/deploy/executor/package.json ./
COPY src/langchain/deepagent/deploy/executor/tsconfig.json ./
COPY src/langchain/deepagent/deploy/executor/server.ts ./

# Install dev deps (only typescript + tsx — no prod deps)
RUN npm install

# Compile TypeScript → server.js
RUN npx tsc

# Workspace jobs directory — must match the agent container's mount point
# chown to 'node' so the non-root user can write inside job subdirectories
RUN mkdir -p /workspace/jobs && chown -R node:node /workspace/jobs && chmod -R 775 /workspace/jobs

# Configure git to trust all directories for the node user.
# The executor intentionally runs git commands in repos cloned by root (the
# agent container). Without this, git refuses with "dubious ownership" on every
# repo the agent clones. safe.directory=* is safe here because the executor has
# no credentials and the only repos it touches are the agent's job clones.
#
# Must be done AS the node user (git config --global writes to ~/.gitconfig),
# then we drop back to root for the remaining RUN steps.
USER node
RUN git config --global safe.directory '*'
USER root

# Run as non-root (node user is built into the node:alpine image)
USER node

# Only expose to localhost — the agent talks to us over 127.0.0.1:8080
EXPOSE 8080

CMD ["node", "dist/server.js"]

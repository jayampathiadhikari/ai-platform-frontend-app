#!/bin/sh
# =============================================================================
# entrypoint.sh — Agent container startup script
# =============================================================================
# Docker named volumes retain their ownership from when they were first
# created. Dockerfile-layer chown/chmod commands are overridden at runtime
# by the mounted volume. This script fixes /workspace/jobs permissions each
# time the container starts, before exec-ing the main node process.
#
# The agent runs as root so it can:
#   1. chmod /workspace/jobs → world-writable (executor's node user can write)
#   2. git clone job directories (needs write access to /workspace/jobs)
# =============================================================================

set -e

JOBS_DIR="${JOBS_DIR:-/workspace/jobs}"

echo "[entrypoint] Fixing permissions on ${JOBS_DIR}..."
mkdir -p "${JOBS_DIR}"
chmod 777 "${JOBS_DIR}"
echo "[entrypoint] ${JOBS_DIR} is ready (chmod 777)"

# Replace this shell with the main process (preserves signals)
exec "$@"

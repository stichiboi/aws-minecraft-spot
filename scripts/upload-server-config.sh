#!/bin/bash
# Uploads server config files (server.properties, jvm-args.txt) and every EC2
# boot/runtime script in lib/ (*.sh, *.py) to s3://BUCKET/tools/. The instance
# pulls tools/ on every boot (see lib/boot-bootstrap.sh and lib/per-boot.sh).
#
# Usage: upload-server-config.sh <bucket-name>
set -euo pipefail

BUCKET_NAME="${1:?Usage: upload-server-config.sh <bucket-name>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
SERVER_RES="${PROJECT_DIR}/resources/server"

# ── Server config (jvm-args.txt, server.properties) ──────────────────────
if [[ -d "${SERVER_RES}" ]]; then
  echo "▸ Uploading server config to s3://${BUCKET_NAME}/server/..."
  for f in jvm-args.txt server.properties; do
    if [[ -f "${SERVER_RES}/${f}" ]]; then
      aws s3 cp "${SERVER_RES}/${f}" "s3://${BUCKET_NAME}/server/${f}"
    fi
  done
else
  echo "▸ No resources/server/ folder found — skipping server config upload."
fi

# ── Tools (boot scripts, monitor, RCON helper, status query, ...) ─────────
# user-data.sh and boot-bootstrap.sh are baked into the launch template instead.
echo ""
echo "▸ Syncing lib/*.sh and lib/*.py to s3://${BUCKET_NAME}/tools/..."
aws s3 sync "${PROJECT_DIR}/lib/" "s3://${BUCKET_NAME}/tools/" --delete \
  --exclude "*" --include "*.sh" --include "*.py" \
  --exclude "*/*" --exclude "user-data.sh" --exclude "boot-bootstrap.sh"

echo ""
echo "✓ Server config upload complete."

#!/bin/bash
# Uploads server config files (server.properties, jvm-args.txt) and the RCON
# helper to S3.  Called by upload-server.sh after the heavy JAR upload, and
# independently by the sync-server Taskfile task for quick config pushes.
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

# ── RCON helper ───────────────────────────────────────────────────────────
echo ""
echo "▸ Uploading RCON helper to s3://${BUCKET_NAME}/tools/..."
aws s3 cp "${PROJECT_DIR}/lib/rcon_query.py" "s3://${BUCKET_NAME}/tools/rcon_query.py"

echo ""
echo "✓ Server config upload complete."

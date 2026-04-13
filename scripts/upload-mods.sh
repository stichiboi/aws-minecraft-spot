#!/bin/bash
# Uploads mod JARs and mod config files to S3.
# Server config (server.properties, jvm-args, rcon) is handled by
# upload-server-config.sh instead.
#
# Usage: upload-mods.sh <bucket-name>
set -euo pipefail

BUCKET_NAME="${1:?Usage: upload-mods.sh <bucket-name>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
RESOURCES_DIR="${PROJECT_DIR}/resources"

# ── Mods ──────────────────────────────────────────────────────────────────
MODS_DIR="${RESOURCES_DIR}/mods"
MOD_COUNT=$(find "${MODS_DIR}" -name "*.jar" 2>/dev/null | wc -l | tr -d ' ')
if [[ "${MOD_COUNT}" -eq 0 ]]; then
  echo "▸ No .jar files found in resources/mods/ — skipping mod sync."
else
  echo "▸ Syncing ${MOD_COUNT} mod(s) to s3://${BUCKET_NAME}/mods/..."
  aws s3 sync "${MODS_DIR}" "s3://${BUCKET_NAME}/mods/" --delete --exclude "*" --include "*.jar"
fi

# ── Mods config ───────────────────────────────────────────────────────────
echo ""
MODS_CONFIG_DIR="${RESOURCES_DIR}/mods-config"
if [[ ! -d "${MODS_CONFIG_DIR}" ]]; then
  echo "▸ No resources/mods-config/ folder found — skipping mod config sync."
else
  echo "▸ Syncing mods-config/ to s3://${BUCKET_NAME}/mods-config/..."
  aws s3 sync "${MODS_CONFIG_DIR}/" "s3://${BUCKET_NAME}/mods-config/" --delete
fi

echo ""
echo "✓ Mods upload complete."

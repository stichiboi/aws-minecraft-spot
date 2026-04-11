#!/bin/bash
set -euo pipefail

BUCKET_NAME="${1:?Usage: upload-mods.sh <bucket-name>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
MODS_DIR="${PROJECT_DIR}/mods"

cd "${PROJECT_DIR}"

echo "▸ Uploading server config to s3://${BUCKET_NAME}/config/..."
aws s3 sync server-config/ "s3://${BUCKET_NAME}/config/" --delete

echo ""
MOD_COUNT=$(find "${MODS_DIR}" -name "*.jar" 2>/dev/null | wc -l | tr -d ' ')
if [[ "${MOD_COUNT}" -eq 0 ]]; then
  echo "▸ No .jar files found in mods/ — skipping mod sync."
else
  echo "▸ Syncing ${MOD_COUNT} mod(s) to s3://${BUCKET_NAME}/mods/..."
  aws s3 sync "${MODS_DIR}" "s3://${BUCKET_NAME}/mods/" --delete --exclude "*" --include "*.jar"
fi

echo ""
MODS_CONFIG_DIR="${PROJECT_DIR}/mods-config"
if [[ ! -d "${MODS_CONFIG_DIR}" ]]; then
  echo "▸ No mods-config/ folder found — skipping mod config sync."
else
  echo "▸ Syncing mods-config/ to s3://${BUCKET_NAME}/mods-config/..."
  aws s3 sync "${MODS_CONFIG_DIR}/" "s3://${BUCKET_NAME}/mods-config/" --delete
fi

echo ""
echo "✓ Upload complete."
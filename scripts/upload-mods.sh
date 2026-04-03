#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
MODS_DIR="${PROJECT_DIR}/mods"

cd "${PROJECT_DIR}"

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "MinecraftBucket" \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

echo "▸ Uploading server config to s3://${BUCKET_NAME}/config/..."
aws s3 cp server-config/config.json "s3://${BUCKET_NAME}/config/config.json"
aws s3 cp server-config/server.properties "s3://${BUCKET_NAME}/config/server.properties"

echo ""
MOD_COUNT=$(find "${MODS_DIR}" -name "*.jar" 2>/dev/null | wc -l | tr -d ' ')
if [[ "${MOD_COUNT}" -eq 0 ]]; then
  echo "▸ No .jar files found in mods/ — skipping mod sync."
else
  echo "▸ Syncing ${MOD_COUNT} mod(s) to s3://${BUCKET_NAME}/mods/..."
  aws s3 sync "${MODS_DIR}" "s3://${BUCKET_NAME}/mods/" --delete --exclude "*" --include "*.jar"
fi

echo ""
echo "✓ Upload complete."
echo "  Note: changes only take effect on next boot."

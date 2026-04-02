#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
MODS_DIR="${PROJECT_DIR}/mods"

STACK_NAME="MinecraftServer"

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

if [[ ! -d "${MODS_DIR}" ]]; then
  echo "No mods/ directory found. Creating it..."
  mkdir -p "${MODS_DIR}"
  echo "Place .jar mod files in ${MODS_DIR} and re-run this script."
  exit 0
fi

MOD_COUNT=$(find "${MODS_DIR}" -name "*.jar" | wc -l | tr -d ' ')

if [[ "${MOD_COUNT}" -eq 0 ]]; then
  echo "No .jar files found in mods/."
  echo "Place mod files there and re-run this script."
  exit 0
fi

echo "Syncing ${MOD_COUNT} mod(s) to s3://${BUCKET_NAME}/mods/ ..."
aws s3 sync "${MODS_DIR}" "s3://${BUCKET_NAME}/mods/" --delete --exclude "*" --include "*.jar"

echo ""
echo "✓ Mods uploaded. Restart the server to apply:"
echo "  bash scripts/stop-server.sh && bash scripts/start-server.sh"

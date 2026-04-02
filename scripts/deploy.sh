#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

cd "${PROJECT_DIR}"

echo "▸ Uploading server config to S3..."
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name MinecraftServer \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text 2>/dev/null || echo "")

if [[ -n "${BUCKET_NAME}" && "${BUCKET_NAME}" != "None" ]]; then
  aws s3 cp server-config/config.json "s3://${BUCKET_NAME}/config/config.json"
  aws s3 cp server-config/server.properties "s3://${BUCKET_NAME}/config/server.properties"
  echo "  Config uploaded to s3://${BUCKET_NAME}/config/"
else
  echo "  Stack not yet deployed - config will be uploaded after first deploy."
fi

echo ""
echo "▸ Running cdk deploy..."
npx cdk deploy --require-approval never "$@"

# Upload config after first deploy if we couldn't earlier
if [[ -z "${BUCKET_NAME}" || "${BUCKET_NAME}" == "None" ]]; then
  BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name MinecraftServer \
    --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
    --output text)

  echo ""
  echo "▸ Uploading server config to newly created bucket..."
  aws s3 cp server-config/config.json "s3://${BUCKET_NAME}/config/config.json"
  aws s3 cp server-config/server.properties "s3://${BUCKET_NAME}/config/server.properties"
  echo "  Done."
fi

echo ""
echo "✓ Deploy complete!"
bash "${SCRIPT_DIR}/status.sh"

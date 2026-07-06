#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Per-boot pulls scripts from s3://…/tools/; sync before every instance deploy so
# infra-only deploys (task deploy-instance, deploy SKIP_UPLOADS=true) stay bootable.
BUCKET_NAME=$(bash scripts/get-bucket-name.sh)
echo "▸ Uploading server config and boot tools to s3://${BUCKET_NAME}/..."
bash scripts/upload-server-config.sh "${BUCKET_NAME}"

echo ""
echo "▸ Deploying MinecraftServer..."
npx cdk deploy MinecraftServer --require-approval never "$@"

echo ""
echo "✓ Deploy complete!"

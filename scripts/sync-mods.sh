#!/bin/bash
# Syncs mod JARs and mod configs from S3 to the running EC2 instance via SSM.
# Does NOT restart the service — use restart-server.sh for that.
#
# Usage: sync-mods.sh <instance-id> <bucket-name>
set -euo pipefail

INSTANCE_ID="${1:?Usage: sync-mods.sh <instance-id> <bucket-name>}"
BUCKET_NAME="${2:?Usage: sync-mods.sh <instance-id> <bucket-name>}"

source "$(dirname "${BASH_SOURCE[0]}")/lib/ssm-run.sh"

SERVER_DIR="/opt/minecraft/data/server"

echo "▸ Syncing mods on instance ${INSTANCE_ID} via SSM..."

ssm_run "${INSTANCE_ID}" "$(json_array \
  "aws s3 sync s3://${BUCKET_NAME}/mods/ ${SERVER_DIR}/mods/ --delete --only-show-errors" \
  "aws s3 sync s3://${BUCKET_NAME}/mods-config/ ${SERVER_DIR}/config/ --delete --only-show-errors" \
  "aws s3 sync s3://${BUCKET_NAME}/datapacks/ ${SERVER_DIR}/world/datapacks/ --delete --only-show-errors" \
  "chown -R minecraft:minecraft ${SERVER_DIR}/mods ${SERVER_DIR}/config ${SERVER_DIR}/world/datapacks" \
  "echo 'Mods and datapacks synced.'" \
)"

echo ""
echo "✓ Mods synced to instance."

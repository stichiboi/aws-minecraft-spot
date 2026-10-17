#!/bin/bash
# Syncs server files (server-bin/, server config, tools/) from S3 to the
# running EC2 instance via SSM. Does NOT restart the service — use
# restart-server.sh for that.
#
# Usage: sync-server.sh <instance-id> <bucket-name>
set -euo pipefail

INSTANCE_ID="${1:?Usage: sync-server.sh <instance-id> <bucket-name>}"
BUCKET_NAME="${2:?Usage: sync-server.sh <instance-id> <bucket-name>}"

source "$(dirname "${BASH_SOURCE[0]}")/lib/ssm-run.sh"

SERVER_DIR="/opt/minecraft/data/server"

echo "▸ Syncing server files on instance ${INSTANCE_ID} via SSM..."

# Same layout as lib/per-boot.sh.
ssm_run "${INSTANCE_ID}" "$(json_array \
  "aws s3 sync s3://${BUCKET_NAME}/server-bin/libraries/ ${SERVER_DIR}/libraries/ --delete --only-show-errors" \
  "aws s3 sync s3://${BUCKET_NAME}/server-bin/ ${SERVER_DIR}/ --only-show-errors --exclude 'libraries/*' --exclude 'mods/*' --exclude 'world/*' --exclude 'config/*'" \
  "aws s3 cp s3://${BUCKET_NAME}/server/jvm-args.txt ${SERVER_DIR}/jvm-args.txt || true" \
  "aws s3 cp s3://${BUCKET_NAME}/server/server.properties ${SERVER_DIR}/server.properties || true" \
  "aws s3 cp s3://${BUCKET_NAME}/tools/start.sh ${SERVER_DIR}/start.sh && chmod +x ${SERVER_DIR}/start.sh" \
  "aws s3 cp s3://${BUCKET_NAME}/tools/ /opt/minecraft/ --recursive --only-show-errors --exclude start.sh --exclude per-boot.sh" \
  "chmod 755 /opt/minecraft/*.sh /opt/minecraft/*.py" \
  "chown -R minecraft:minecraft /opt/minecraft/data" \
  "echo 'Server files synced.'" \
)"

echo ""
echo "✓ Server files synced to instance."

#!/bin/bash
# Syncs server files (server-bin/, server config, RCON helper) from S3 to the
# running EC2 instance via SSM.  Does NOT restart the service — use
# restart-server.sh for that.
#
# Usage: sync-server.sh <instance-id> <bucket-name>
set -euo pipefail

INSTANCE_ID="${1:?Usage: sync-server.sh <instance-id> <bucket-name>}"
BUCKET_NAME="${2:?Usage: sync-server.sh <instance-id> <bucket-name>}"

echo "▸ Syncing server files on instance ${INSTANCE_ID} via SSM..."

COMMAND_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --parameters commands="[
    \"aws s3 sync s3://${BUCKET_NAME}/server-bin/ /opt/minecraft/data/server/ --exclude 'mods/*' --exclude 'world/*' --exclude 'config/*'\",
    \"aws s3 cp s3://${BUCKET_NAME}/server/jvm-args.txt /opt/minecraft/data/server/jvm-args.txt || true\",
    \"aws s3 cp s3://${BUCKET_NAME}/server/server.properties /opt/minecraft/data/server/server.properties || true\",
    \"aws s3 cp s3://${BUCKET_NAME}/tools/rcon_query.py /opt/minecraft/rcon_query.py && chmod +x /opt/minecraft/rcon_query.py\",
    \"aws s3 cp s3://${BUCKET_NAME}/tools/status_query.py /opt/minecraft/status_query.py && chmod +x /opt/minecraft/status_query.py\",
    \"chown -R minecraft:minecraft /opt/minecraft/data /opt/minecraft/rcon_query.py /opt/minecraft/status_query.py\",
    \"echo 'Server files synced.'\"
  ]" \
  --query 'Command.CommandId' \
  --output text)

echo "  SSM command ID: ${COMMAND_ID}"
echo "  Waiting for completion..."

aws ssm wait command-executed \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" 2>/dev/null || true

STATUS=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query 'StatusDetails' \
  --output text)

OUTPUT=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query 'StandardOutputContent' \
  --output text)

echo ""
echo "${OUTPUT}"
echo "▸ Status: ${STATUS}"

if [[ "${STATUS}" != "Success" ]]; then
  STDERR=$(aws ssm get-command-invocation \
    --command-id "${COMMAND_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --query 'StandardErrorContent' \
    --output text)
  echo ""
  echo "STDERR: ${STDERR}" >&2
  exit 1
fi

echo ""
echo "✓ Server files synced to instance."

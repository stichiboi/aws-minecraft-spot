#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. Upload local mods to S3 ────────────────────────────────────
echo "▸ Uploading mods to S3..."
bash "${SCRIPT_DIR}/upload-mods.sh"

# ── 2. Get instance ID ────────────────────────────────────────────
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=MinecraftServer" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "ERROR: No running MinecraftServer instance found." >&2
  exit 1
fi

echo ""
echo "▸ Syncing mods on instance ${INSTANCE_ID} via SSM..."

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "MinecraftBucket" \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

# ── 3. Run sync + service restart on EC2 via SSM Run Command ─────
COMMAND_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --parameters commands="[
    \"aws s3 sync s3://${BUCKET_NAME}/mods/ /opt/minecraft/data/server/mods/ --delete\",
    \"systemctl restart minecraft.service\",
    \"echo 'Done. Service restarted.'\"
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
echo "✓ Mods synced and server restarted."
echo "  Run 'task logs:server -- --follow' to watch the server come back up."

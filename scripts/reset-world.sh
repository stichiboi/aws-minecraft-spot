#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: reset-world.sh <instance-id>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATHS_FILE="${SCRIPT_DIR}/../server-paths.txt"
SERVER_DIR="/opt/minecraft/data/server"

echo "WARNING: This will permanently delete the Minecraft world on instance ${INSTANCE_ID}."
echo "Folders to be deleted: world/, world_nether/, world_the_end/"

# Collect extra paths from server-paths.txt
EXTRA_PATHS=()
if [[ -f "${PATHS_FILE}" ]]; then
  while IFS= read -r line; do
    [[ -z "${line}" || "${line}" =~ ^# ]] && continue
    EXTRA_PATHS+=("${line}")
  done < "${PATHS_FILE}"
fi

if [[ ${#EXTRA_PATHS[@]} -gt 0 ]]; then
  echo "Extra paths (from server-paths.txt):"
  for p in "${EXTRA_PATHS[@]}"; do
    echo "  ${SERVER_DIR}/${p}"
  done
fi

echo ""
read -r -p "Type 'yes' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

# Build the list of shell commands to run via SSM
COMMANDS=(
  "systemctl stop minecraft.service"
  "echo 'Service stopped.'"
  "rm -rf '${SERVER_DIR}/world' '${SERVER_DIR}/world_nether' '${SERVER_DIR}/world_the_end'"
  "echo 'World folders deleted.'"
)

if [[ ${#EXTRA_PATHS[@]} -gt 0 ]]; then
  for p in "${EXTRA_PATHS[@]}"; do
    COMMANDS+=("rm -rf '${SERVER_DIR}/${p}' && echo 'Deleted: ${p}' || echo 'Not found (skipped): ${p}'")
  done
fi

COMMANDS+=(
  "systemctl start minecraft.service"
  "echo 'Service started.'"
)

# Encode commands as a JSON array for SSM
COMMANDS_JSON=$(printf '%s\n' "${COMMANDS[@]}" | jq -R . | jq -s .)

echo ""
echo "▸ Resetting world on instance ${INSTANCE_ID} via SSM..."

COMMAND_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=${COMMANDS_JSON}" \
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
echo "✓ World reset complete. Server is restarting with a fresh world."

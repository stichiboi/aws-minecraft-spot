#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: status.sh <instance-id> <bucket-name>}"
BUCKET_NAME="${2:?Usage: status.sh <instance-id> <bucket-name>}"

SERVER_ADDR=$(aws cloudformation describe-stacks \
  --stack-name "MinecraftServer" \
  --query 'Stacks[0].Outputs[?OutputKey==`ServerAddress`].OutputValue' \
  --output text)

MC_PORT=$(aws cloudformation describe-stacks \
  --stack-name "MinecraftServer" \
  --query 'Stacks[0].Outputs[?OutputKey==`MinecraftPort`].OutputValue' \
  --output text)
MC_PORT="${MC_PORT:-25565}"

INSTANCE_STATE=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text 2>/dev/null || echo "unknown")

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text 2>/dev/null || echo "N/A")

# Use the public IP for probing (more direct than DNS which may lag after a relaunch)
PROBE_HOST=""
if [[ -n "${PUBLIC_IP}" && "${PUBLIC_IP}" != "None" && "${PUBLIC_IP}" != "N/A" ]]; then
  PROBE_HOST="${PUBLIC_IP}"
fi

mc_ready() {
  local host="$1" port="$2"
  [[ -z "${host}" ]] && return 1
  nc -z -w 3 "${host}" "${port}" &>/dev/null
}

if [[ "${INSTANCE_STATE}" != "running" ]]; then
  MC_STATUS="offline"
elif [[ -z "${PROBE_HOST}" ]]; then
  MC_STATUS="unknown (no IP)"
elif mc_ready "${PROBE_HOST}" "${MC_PORT}"; then
  MC_STATUS="ready"
else
  MC_STATUS="starting..."
fi

echo "╭─────────────────────────────────────────╮"
echo "│       Minecraft Server Status           │"
echo "├─────────────────────────────────────────┤"
printf "│  Instance:   %-26s│\n" "${INSTANCE_ID}"
printf "│  State:      %-26s│\n" "${INSTANCE_STATE}"
printf "│  Public IP:  %-26s│\n" "${PUBLIC_IP}"
printf "│  Address:    %-26s│\n" "${SERVER_ADDR}"
printf "│  Server:     %-26s│\n" "${MC_STATUS}"
printf "│  Bucket:     %-26s│\n" "${BUCKET_NAME}"
echo "╰─────────────────────────────────────────╯"

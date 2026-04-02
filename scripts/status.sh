#!/bin/bash
set -euo pipefail

STACK_NAME="MinecraftServer"

stack_exists() {
  aws cloudformation describe-stacks --stack-name "${STACK_NAME}" &>/dev/null
}

if ! stack_exists; then
  echo "Stack '${STACK_NAME}' does not exist. Run scripts/deploy.sh first."
  exit 0
fi

INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

SERVER_ADDR=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs[?OutputKey==`ServerAddress`].OutputValue' \
  --output text)

INSTANCE_STATE=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text 2>/dev/null || echo "unknown")

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text 2>/dev/null || echo "N/A")

# Pick a host to probe: public IP when present, else DNS/server address from the stack.
REACH_HOST=""
if [[ -n "${PUBLIC_IP}" && "${PUBLIC_IP}" != "None" && "${PUBLIC_IP}" != "N/A" ]]; then
  REACH_HOST="${PUBLIC_IP}"
elif [[ -n "${SERVER_ADDR}" && "${SERVER_ADDR}" != "None" ]]; then
  REACH_HOST="${SERVER_ADDR}"
fi

ping_reachable() {
  local host="$1"
  [[ -z "${host}" ]] && return 1
  case "$(uname -s)" in
    Darwin)
      # -W is wait per reply in milliseconds
      ping -c 1 -W 2000 "${host}" &>/dev/null
      ;;
    *)
      # GNU iputils: -W is max seconds to wait for replies
      ping -c 1 -W 2 "${host}" &>/dev/null
      ;;
  esac
}

PING_FAILED=0
if [[ "${INSTANCE_STATE}" != "running" ]]; then
  REACH_SUMMARY="skipped (not running)"
elif [[ -z "${REACH_HOST}" ]]; then
  REACH_SUMMARY="skipped (no host to ping)"
elif ping_reachable "${REACH_HOST}"; then
  REACH_SUMMARY="yes (ICMP reply)"
else
  REACH_SUMMARY="no (ICMP)"
  PING_FAILED=1
fi

echo "╭─────────────────────────────────────────╮"
echo "│       Minecraft Server Status           │"
echo "├─────────────────────────────────────────┤"
printf "│  Instance:   %-26s│\n" "${INSTANCE_ID}"
printf "│  State:      %-26s│\n" "${INSTANCE_STATE}"
printf "│  Public IP:  %-26s│\n" "${PUBLIC_IP}"
printf "│  Address:    %-26s│\n" "${SERVER_ADDR}"
printf "│  Reachable:  %-26s│\n" "${REACH_SUMMARY}"
printf "│  Bucket:     %-26s│\n" "${BUCKET_NAME}"
echo "╰─────────────────────────────────────────╯"

if [[ "${INSTANCE_STATE}" == "running" && -n "${REACH_HOST}" ]]; then
  echo "  ICMP probe target: ${REACH_HOST}"
fi

if (( PING_FAILED )); then
  echo "" >&2
  echo "Note: EC2 reports running but ping failed. ICMP may be blocked by a security group," >&2
  echo "      NACL, or your network; the instance can still be up (e.g. SSH/Minecraft)." >&2
fi

#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: ssh.sh <instance-id> [key-path]}"
KEY_PATH="${2:-}"

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

if [[ "${PUBLIC_IP}" == "None" || -z "${PUBLIC_IP}" ]]; then
  echo "Instance ${INSTANCE_ID} has no public IP. Is it running?" >&2
  echo "  Current state: $(aws ec2 describe-instances \
    --instance-ids "${INSTANCE_ID}" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text)" >&2
  exit 1
fi

SSH_KEY_ARG=""
if [[ -n "${KEY_PATH}" ]]; then
  SSH_KEY_ARG="-i ${KEY_PATH}"
fi

echo "Connecting to ${PUBLIC_IP} (instance ${INSTANCE_ID})..."
# shellcheck disable=SC2086
ssh ${SSH_KEY_ARG} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "ec2-user@${PUBLIC_IP}"

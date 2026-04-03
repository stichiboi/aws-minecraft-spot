#!/bin/bash
set -euo pipefail

STACK_NAME="MinecraftServer"

INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=MinecraftServer" \
            "Name=instance-state-name,Values=pending,running,stopped,stopping" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "No MinecraftServer instance found. Is it running?"
  exit 1
fi

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

if [[ "${PUBLIC_IP}" == "None" || -z "${PUBLIC_IP}" ]]; then
  echo "Instance ${INSTANCE_ID} has no public IP. Is it running?"
  echo "  Current state: $(aws ec2 describe-instances \
    --instance-ids "${INSTANCE_ID}" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text)"
  exit 1
fi

SSH_KEY_ARG=""
if [[ -n "${1:-}" ]]; then
  SSH_KEY_ARG="-i ${1}"
fi

echo "Connecting to ${PUBLIC_IP} (instance ${INSTANCE_ID})..."
# shellcheck disable=SC2086
ssh ${SSH_KEY_ARG} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "ec2-user@${PUBLIC_IP}"

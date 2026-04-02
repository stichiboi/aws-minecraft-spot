#!/bin/bash
set -euo pipefail

STACK_NAME="MinecraftServer"

INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)

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

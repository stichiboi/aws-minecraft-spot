#!/bin/bash
set -euo pipefail

STACK_NAME="MinecraftServer"

INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)

CURRENT_STATE=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)

if [[ "${CURRENT_STATE}" == "running" ]]; then
  echo "Instance ${INSTANCE_ID} is already running."
  bash "$(dirname "${BASH_SOURCE[0]}")/status.sh"
  exit 0
fi

echo "Starting instance ${INSTANCE_ID} (current state: ${CURRENT_STATE})..."
aws ec2 start-instances --instance-ids "${INSTANCE_ID}"

echo "Waiting for instance to enter 'running' state..."
aws ec2 wait instance-running --instance-ids "${INSTANCE_ID}"

echo ""
echo "✓ Instance is running!"
sleep 5
bash "$(dirname "${BASH_SOURCE[0]}")/status.sh"

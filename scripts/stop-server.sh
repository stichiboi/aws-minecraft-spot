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

if [[ "${CURRENT_STATE}" == "stopped" ]]; then
  echo "Instance ${INSTANCE_ID} is already stopped."
  exit 0
fi

echo "Stopping instance ${INSTANCE_ID} (current state: ${CURRENT_STATE})..."
aws ec2 stop-instances --instance-ids "${INSTANCE_ID}"

echo "Waiting for instance to stop..."
aws ec2 wait instance-stopped --instance-ids "${INSTANCE_ID}"

echo ""
echo "✓ Instance stopped. EBS volume is preserved."
echo "  Run scripts/start-server.sh to restart."

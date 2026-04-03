#!/bin/bash
set -euo pipefail

STACK_NAME="MinecraftServer"

INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=MinecraftServer" \
            "Name=instance-state-name,Values=pending,running,stopped,stopping" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "No MinecraftServer instance found. Is the stack deployed?"
  exit 1
fi

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

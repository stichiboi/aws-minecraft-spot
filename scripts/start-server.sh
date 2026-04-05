#!/bin/bash
set -euo pipefail

# Check if a MinecraftServer instance is already pending or running
EXISTING=$(aws ec2 describe-instances \
  --filters \
    "Name=tag:Name,Values=MinecraftServer" \
    "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

if [[ -n "${EXISTING}" && "${EXISTING}" != "None" ]]; then
  echo "Instance ${EXISTING} is already pending/running."
  exit 0
fi

# Look up the public subnet via CDK auto-applied tag
SUBNET_ID=$(aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=MinecraftServer/Vpc/PublicSubnet1" \
  --query 'Subnets[0].SubnetId' \
  --output text)

if [[ -z "${SUBNET_ID}" || "${SUBNET_ID}" == "None" ]]; then
  echo "ERROR: Could not find subnet tagged Name=MinecraftServer/Vpc/PublicSubnet1" >&2
  exit 1
fi

echo "Launching new spot instance via launch template MinecraftServer..."
INSTANCE_ID=$(aws ec2 run-instances \
  --launch-template "LaunchTemplateName=MinecraftServer,Version=\$Latest" \
  --subnet-id "${SUBNET_ID}" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "Instance ${INSTANCE_ID} launched. Waiting for running state..."
aws ec2 wait instance-running --instance-ids "${INSTANCE_ID}"

echo ""
echo "Instance is running! (ID: ${INSTANCE_ID})"

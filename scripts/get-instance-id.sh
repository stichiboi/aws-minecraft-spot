#!/bin/bash
set -euo pipefail

INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=MinecraftServer" \
            "Name=instance-state-name,Values=pending,running,stopped,stopping" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "No MinecraftServer instance found. Is the stack deployed?" >&2
  exit 1
fi

echo "${INSTANCE_ID}"

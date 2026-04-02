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

echo "╭─────────────────────────────────────────╮"
echo "│       Minecraft Server Status           │"
echo "├─────────────────────────────────────────┤"
printf "│  Instance:   %-26s│\n" "${INSTANCE_ID}"
printf "│  State:      %-26s│\n" "${INSTANCE_STATE}"
printf "│  Public IP:  %-26s│\n" "${PUBLIC_IP}"
printf "│  Address:    %-26s│\n" "${SERVER_ADDR}"
printf "│  Bucket:     %-26s│\n" "${BUCKET_NAME}"
echo "╰─────────────────────────────────────────╯"

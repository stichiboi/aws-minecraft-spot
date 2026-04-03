#!/bin/bash
set -euo pipefail

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "MinecraftBucket" \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

if [[ -z "${BUCKET_NAME}" || "${BUCKET_NAME}" == "None" ]]; then
  echo "MinecraftBucket stack not found or has no BucketName output. Is the bucket deployed?" >&2
  exit 1
fi

echo "${BUCKET_NAME}"

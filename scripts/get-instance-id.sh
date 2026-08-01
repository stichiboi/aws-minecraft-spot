#!/bin/bash
set -euo pipefail

set +e
AWS_OUTPUT=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=MinecraftServer" \
            "Name=instance-state-name,Values=pending,running,stopped,stopping" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text 2>&1)
AWS_EXIT=$?
set -e

if [[ ${AWS_EXIT} -ne 0 ]]; then
  if [[ "${AWS_OUTPUT}" == *ExpiredToken* || "${AWS_OUTPUT}" == *RequestExpired* ]]; then
    echo "AWS credentials expired (not a server issue). Refresh them, e.g.:" >&2
    echo "  aws sso login          # if you use SSO" >&2
    echo "  awsume <profile>       # if you use awsume" >&2
    echo "Then verify with: aws sts get-caller-identity" >&2
  elif [[ "${AWS_OUTPUT}" == *AccessDenied* || "${AWS_OUTPUT}" == *UnauthorizedOperation* ]]; then
    echo "AWS access denied looking up MinecraftServer. Need ec2:DescribeInstances permission." >&2
  else
    echo "Failed to look up MinecraftServer instance:" >&2
    echo "${AWS_OUTPUT}" >&2
  fi
  exit 1
fi

INSTANCE_ID="${AWS_OUTPUT}"

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "No MinecraftServer instance found. Is the stack deployed?" >&2
  exit 1
fi

echo "${INSTANCE_ID}"

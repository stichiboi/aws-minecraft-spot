#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: stop-server.sh <instance-id>}"

CURRENT_STATE=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)

if [[ "${CURRENT_STATE}" == "terminated" || "${CURRENT_STATE}" == "shutting-down" ]]; then
  echo "Instance ${INSTANCE_ID} is already terminating/terminated."
  exit 0
fi

SPOT_REQUEST_ID=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].SpotInstanceRequestId' \
  --output text)

if [[ -n "${SPOT_REQUEST_ID}" && "${SPOT_REQUEST_ID}" != "None" ]]; then
  echo "Cancelling spot request ${SPOT_REQUEST_ID} (prevents auto-relaunch)..."
  aws ec2 cancel-spot-instance-requests \
    --spot-instance-request-ids "${SPOT_REQUEST_ID}" > /dev/null
fi

echo "Terminating instance ${INSTANCE_ID} (async)..."
aws ec2 terminate-instances --instance-ids "${INSTANCE_ID}" > /dev/null

echo ""
echo "Done. Instance is terminating in the background."
echo "  Run 'task start-server' to launch a new instance."

#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: start-server.sh <instance-id>}"

CURRENT_STATE=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)

if [[ "${CURRENT_STATE}" == "running" ]]; then
  echo "Instance ${INSTANCE_ID} is already running."
  exit 0
fi

# For persistent spot instances, manually stopping the instance puts the spot
# request into 'disabled' state — start-instances is blocked in that state.
# The only way to re-enable a disabled spot request is to terminate the stopped
# instance; AWS then flips the request back to 'open' and relaunches automatically.
if [[ "${CURRENT_STATE}" == "stopped" ]]; then
  SPOT_REQUEST_ID=$(aws ec2 describe-instances \
    --instance-ids "${INSTANCE_ID}" \
    --query 'Reservations[0].Instances[0].SpotInstanceRequestId' \
    --output text)

  if [[ -n "${SPOT_REQUEST_ID}" && "${SPOT_REQUEST_ID}" != "None" ]]; then
    echo "Spot instance detected (request: ${SPOT_REQUEST_ID})."
    echo "Terminating stopped instance to re-enable the persistent spot request..."
    aws ec2 terminate-instances --instance-ids "${INSTANCE_ID}" > /dev/null
    echo "Terminated. Waiting for spot request to fulfill a new instance..."

    NEW_INSTANCE_ID=""
    for attempt in $(seq 1 60); do
      NEW_INSTANCE_ID=$(aws ec2 describe-spot-instance-requests \
        --spot-instance-request-ids "${SPOT_REQUEST_ID}" \
        --query 'SpotInstanceRequests[0].InstanceId' \
        --output text 2>/dev/null || true)
      if [[ -n "${NEW_INSTANCE_ID}" && "${NEW_INSTANCE_ID}" != "None" && "${NEW_INSTANCE_ID}" != "${INSTANCE_ID}" ]]; then
        break
      fi
      echo "  Waiting for spot fulfillment... (${attempt}/60)"
      sleep 10
    done

    if [[ -z "${NEW_INSTANCE_ID}" || "${NEW_INSTANCE_ID}" == "None" ]]; then
      echo "ERROR: Spot request was not fulfilled after 10 minutes." >&2
      echo "  Check capacity/pricing: aws ec2 describe-spot-instance-requests --spot-instance-request-ids ${SPOT_REQUEST_ID}" >&2
      exit 1
    fi

    echo "New instance launched: ${NEW_INSTANCE_ID}"
    aws ec2 create-tags --resources "${NEW_INSTANCE_ID}" --tags Key=Name,Value=MinecraftServer
    echo "Waiting for it to be running..."
    aws ec2 wait instance-running --instance-ids "${NEW_INSTANCE_ID}"
    echo ""
    echo "✓ Instance is running! (new ID: ${NEW_INSTANCE_ID})"
    exit 0
  fi
fi

echo "Starting instance ${INSTANCE_ID} (current state: ${CURRENT_STATE})..."
aws ec2 start-instances --instance-ids "${INSTANCE_ID}"

echo "Waiting for instance to enter 'running' state..."
aws ec2 wait instance-running --instance-ids "${INSTANCE_ID}"

echo ""
echo "✓ Instance is running!"

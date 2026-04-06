#!/bin/bash
set -euo pipefail

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

aws lambda invoke \
  --function-name minecraft-server-management \
  --cli-binary-format raw-in-base64-out \
  --payload '{"commandName":"status"}' \
  "$TMPFILE" > /dev/null

BUCKET_NAME=$(bash "$(dirname "${BASH_SOURCE[0]}")/get-bucket-name.sh" 2>/dev/null || echo "N/A")

jq -r '
  if .status == "not_found" then
    "Server is offline. No instance found."
  elif .status == "found" then
    "Instance: \(.instanceId) (\(.instanceType))\nState:    \(.instanceState)\nIP:       \(.publicIp)\nAddress:  \(.fqdn)\nServer:   \(.mcStatus)"
  else
    .
  end
' "$TMPFILE"
echo "Bucket:   ${BUCKET_NAME}"

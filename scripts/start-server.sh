#!/bin/bash
set -euo pipefail

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

aws lambda invoke \
  --function-name minecraft-server-management \
  --cli-binary-format raw-in-base64-out \
  --payload '{"commandName":"start"}' \
  "$TMPFILE" > /dev/null

STATUS=$(jq -r '.status' "$TMPFILE")

jq -r '
  if .status == "already_running" then
    "Already running: \(.instanceId)"
  elif .status == "started" then
    "Server starting...\nInstance: \(.instanceId) (\(.instanceType))\nConnect:  \(.fqdn):\(.port)"
  elif .status == "volume_in_use" then
    "Cannot start: data volume \(.volumeId) is still attached to the previous instance. Wait a moment and try again."
  elif .status == "no_capacity" then
    "No spot capacity in \(.az). Tried: \(.types | join(", ")). Try again in a few minutes."
  else
    .
  end
' "$TMPFILE"

if [[ "$STATUS" == "volume_in_use" ]]; then
  exit 1
fi

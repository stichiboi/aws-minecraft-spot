#!/bin/bash
set -euo pipefail

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

aws lambda invoke \
  --function-name minecraft-server-management \
  --cli-binary-format raw-in-base64-out \
  --payload '{"commandName":"stop"}' \
  "$TMPFILE" > /dev/null

jq -r '
  if .status == "not_found" then
    "No running instance found."
  elif .status == "already_terminating" then
    "Instance \(.instanceId) is already terminating."
  elif .status == "stopped" then
    "Server stopped. Instance \(.instanceId) is terminating."
  else
    .
  end
' "$TMPFILE"

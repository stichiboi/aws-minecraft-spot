#!/bin/bash
set -euo pipefail

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

aws lambda invoke \
  --function-name minecraft-server-management \
  --cli-binary-format raw-in-base64-out \
  --payload '{"commandName":"start"}' \
  "$TMPFILE" > /dev/null

jq -r '
  if .status == "already_running" then
    "Already running: \(.instanceId)"
  elif .status == "started" then
    "Server starting...\nInstance: \(.instanceId) (\(.instanceType))\nConnect:  \(.fqdn):\(.port)"
  elif .status == "no_capacity" then
    "No spot capacity in \(.az). Tried: \(.types | join(", ")). Try again in a few minutes."
  else
    .
  end
' "$TMPFILE"

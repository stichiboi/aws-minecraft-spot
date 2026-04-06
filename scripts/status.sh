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
    (
      "Instance: \(.instanceId) (\(.instanceType))\nState:    \(.instanceState)\nIP:       \(.publicIp)\nAddress:  \(.fqdn)\nServer:   \(.mcStatus)" +
      if .stats then
        (
          "\n---" +
          "\nCPU avg:  " + (if (.stats.cpu | length) > 0 then ((.stats.cpu | map(.value) | add / length) | round | tostring) + "%" else "N/A" end) +
          "\nNet in:   " + (if (.stats.networkIn | length) > 0 then ((.stats.networkIn | map(.value) | add / 1048576 * 10 | round / 10) | tostring) + " MB" else "N/A" end) +
          "\nNet out:  " + (if (.stats.networkOut | length) > 0 then ((.stats.networkOut | map(.value) | add / 1048576 * 10 | round / 10) | tostring) + " MB" else "N/A" end) +
          "\nRAM used: " + (if .stats.ramUsedGb != null then (.stats.ramUsedGb | tostring) + " GB" + (if .stats.ramTotalGb != null then " / " + (.stats.ramTotalGb | tostring) + " GB" else "" end) else "N/A" end) +
          "\nDisk:     " + (if .stats.diskUsedGb != null then (.stats.diskUsedGb | tostring) + " GB" + (if .stats.diskTotalGb != null then " / " + (.stats.diskTotalGb | tostring) + " GB" else "" end) else "N/A" end)
        )
      else "" end
    )
  else
    .
  end
' "$TMPFILE"
echo "Bucket:   ${BUCKET_NAME}"

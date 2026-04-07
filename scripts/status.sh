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
          "\nCPU:      " + (if .stats.cpu.error then ("error: " + .stats.cpu.error) elif (.stats.cpu.values | length) > 0 then ((.stats.cpu.values | map(.value) | add / length) | round | tostring) + "% avg  " + ((.stats.cpu.values | map(.value) | max) | round | tostring) + "% max" else "N/A" end) +
          "\nNet in:   " + (if .stats.networkIn.error then ("error: " + .stats.networkIn.error) elif (.stats.networkIn.values | length) > 0 then ((.stats.networkIn.values | map(.value) | add / 1048576 * 10 | round / 10) | tostring) + " MB" else "N/A" end) +
          "\nNet out:  " + (if .stats.networkOut.error then ("error: " + .stats.networkOut.error) elif (.stats.networkOut.values | length) > 0 then ((.stats.networkOut.values | map(.value) | add / 1048576 * 10 | round / 10) | tostring) + " MB" else "N/A" end) +
          "\nRAM:      " + (if .stats.ram.error then ("error: " + .stats.ram.error) else (.stats.ram.value | tostring) + " GB" + (if .stats.ram.max then " / " + (.stats.ram.max | tostring) + " GB" else "" end) end) +
          "\nDisk:     " + (if .stats.disk.error then ("error: " + .stats.disk.error) else (.stats.disk.value | tostring) + " GB" + (if .stats.disk.max then " / " + (.stats.disk.max | tostring) + " GB" else "" end) end)
        )
      else "" end
    )
  else
    .
  end
' "$TMPFILE"
echo "Bucket:   ${BUCKET_NAME}"

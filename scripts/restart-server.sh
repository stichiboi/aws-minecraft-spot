#!/bin/bash
# Restarts minecraft.service and minecraft-monitor.service on the running EC2
# instance via SSM. Shared by sync-server and sync-mods Taskfile tasks.
#
# Usage: restart-server.sh <instance-id>
set -euo pipefail

INSTANCE_ID="${1:?Usage: restart-server.sh <instance-id>}"

source "$(dirname "${BASH_SOURCE[0]}")/lib/ssm-run.sh"

echo "▸ Restarting minecraft.service and minecraft-monitor.service on ${INSTANCE_ID}..."

# The monitor is stopped first: it would treat the restart as a crash and shut down.
ssm_run "${INSTANCE_ID}" "$(json_array \
  "systemctl stop minecraft-monitor.service" \
  "systemctl restart minecraft.service" \
  "systemctl start minecraft-monitor.service" \
  "echo 'minecraft.service and minecraft-monitor.service restarted.'" \
)"

echo ""
echo "✓ Server restarted."

#!/bin/bash
# Restarts minecraft.target on the running EC2 instance via SSM — the same
# unit per-boot.sh starts. Shared by sync-server and sync-mods Taskfile tasks.
#
# Usage: restart-server.sh <instance-id>
set -euo pipefail

INSTANCE_ID="${1:?Usage: restart-server.sh <instance-id>}"

source "$(dirname "${BASH_SOURCE[0]}")/lib/ssm-run.sh"

echo "▸ Restarting minecraft.target on ${INSTANCE_ID}..."

ssm_run "${INSTANCE_ID}" "$(json_array "systemctl restart minecraft.target")"

echo ""
echo "✓ Server restarted."

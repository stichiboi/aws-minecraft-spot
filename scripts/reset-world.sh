#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: reset-world.sh <instance-id>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATHS_FILE="${SCRIPT_DIR}/../server-paths.txt"
SERVER_DIR="/opt/minecraft/data/server"

echo "WARNING: This will permanently delete the Minecraft world on instance ${INSTANCE_ID}."
echo "Folders to be deleted: world/, world_nether/, world_the_end/"

# Collect extra paths from server-paths.txt
EXTRA_PATHS=()
if [[ -f "${PATHS_FILE}" ]]; then
  while IFS= read -r line; do
    [[ -z "${line}" || "${line}" =~ ^# ]] && continue
    EXTRA_PATHS+=("${line}")
  done < "${PATHS_FILE}"
fi

if [[ ${#EXTRA_PATHS[@]} -gt 0 ]]; then
  echo "Extra paths (from server-paths.txt):"
  for p in "${EXTRA_PATHS[@]}"; do
    echo "  ${SERVER_DIR}/${p}"
  done
fi

echo ""
read -r -p "Type 'yes' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

# Build the list of shell commands to run via SSM
COMMANDS=(
  "systemctl stop minecraft.target"
  "echo 'Service stopped.'"
  "rm -rf '${SERVER_DIR}/world' '${SERVER_DIR}/world_nether' '${SERVER_DIR}/world_the_end'"
  "echo 'World folders deleted.'"
)

if [[ ${#EXTRA_PATHS[@]} -gt 0 ]]; then
  for p in "${EXTRA_PATHS[@]}"; do
    COMMANDS+=("rm -rf '${SERVER_DIR}/${p}' && echo 'Deleted: ${p}' || echo 'Not found (skipped): ${p}'")
  done
fi

COMMANDS+=(
  "systemctl start minecraft.target"
  "echo 'Service started.'"
)

source "${SCRIPT_DIR}/lib/ssm-run.sh"

echo ""
echo "▸ Resetting world on instance ${INSTANCE_ID} via SSM..."
ssm_run "${INSTANCE_ID}" "$(json_array "${COMMANDS[@]}")"

echo ""
echo "✓ World reset complete. Server is restarting with a fresh world."

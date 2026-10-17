#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

cd "${PROJECT_DIR}"

echo "⚠  This will stop the server and destroy all stacks (MinecraftServer, MinecraftBucket, MinecraftApi)."
echo "   The S3 bucket and all its contents (mods, backups) will be DELETED."
echo "   The EBS data volume will also be DELETED."
echo ""
read -r -p "Type 'yes' to confirm: " CONFIRM
echo ""

if [[ "${CONFIRM}" == "yes" ]]; then
  # Fleet instances aren't part of any stack, so stop the server while the API stack still exists.
  bash scripts/stop-server.sh || echo "  (stop failed or nothing running — continuing)"
  npx cdk destroy MinecraftServer --force "$@"
  npx cdk destroy MinecraftBucket --force "$@"
  npx cdk destroy MinecraftApi --force "$@"
  echo ""
  echo "✓ All stacks destroyed."
else
  echo "Aborted."
fi

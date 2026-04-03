#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "${SCRIPT_DIR}/.."

echo "▸ Deploying MinecraftServer..."
npx cdk deploy MinecraftServer --require-approval never "$@"

echo ""
echo "✓ Deploy complete!"
echo ""
echo "Note: config/mod changes only take effect on next boot."
echo "      Restart the instance to apply them and refresh DNS:"
echo "        task stop-server && task start-server"
echo ""
bash "${SCRIPT_DIR}/status.sh"

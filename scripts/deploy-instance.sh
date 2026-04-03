#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "▸ Deploying MinecraftServer..."
npx cdk deploy MinecraftServer --require-approval never "$@"

echo ""
echo "✓ Deploy complete!"

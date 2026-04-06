#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "▸ Deploying MinecraftApi..."
npx cdk deploy MinecraftApi --require-approval never "$@"

echo ""
echo "✓ Deploy complete!"

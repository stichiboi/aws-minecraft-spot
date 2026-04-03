#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "▸ Deploying MinecraftBucket..."
npx cdk deploy MinecraftBucket --require-approval never "$@"

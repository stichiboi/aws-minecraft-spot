#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

cd "${PROJECT_DIR}"

echo "⚠  This will destroy the MinecraftServer stack."
echo "   The S3 bucket (with mods/backups) will be RETAINED."
echo "   The EBS volume will be RETAINED (deleteOnTermination=false)."
echo ""
read -p "Are you sure? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  npx cdk destroy --force "$@"
  echo ""
  echo "✓ Stack destroyed."
else
  echo "Aborted."
fi

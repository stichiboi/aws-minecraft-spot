#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

cd "${PROJECT_DIR}"

echo "⚠  This will destroy both stacks (MinecraftServer + MinecraftBucket)."
echo "   The S3 bucket and all its contents (mods, backups) will be DELETED."
echo "   The EBS data volume will also be DELETED."
echo ""
read -p "Are you sure? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  npx cdk destroy MinecraftServer --force "$@"
  npx cdk destroy MinecraftBucket --force "$@"
  echo ""
  echo "✓ All stacks destroyed."
else
  echo "Aborted."
fi

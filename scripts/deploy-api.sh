#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Without the public key the handler rejects every Discord request.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
if [[ -z "${DISCORD_PUBLIC_KEY:-}" ]]; then
  echo "ERROR: DISCORD_PUBLIC_KEY is not set (see .env.example and discord/README.md)." >&2
  exit 1
fi

echo "▸ Deploying MinecraftApi..."
npx cdk deploy MinecraftApi --require-approval never "$@"

echo ""
echo "✓ Deploy complete!"

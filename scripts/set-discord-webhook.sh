#!/bin/bash
# Stores the Discord channel webhook URL used for lifecycle notifications
# (ready, idle stop, spot reclaim, boot failure) as an SSM SecureString.
# The instance reads it on every notification, so no redeploy is needed.
#
# Usage: set-discord-webhook.sh <webhook-url>      store / replace
#        set-discord-webhook.sh --delete           turn notifications off
set -euo pipefail

PARAM="/minecraft/secrets/discord-webhook-url"
ARG="${1:?Usage: set-discord-webhook.sh <webhook-url> | --delete}"

if [[ "${ARG}" == "--delete" ]]; then
  aws ssm delete-parameter --name "${PARAM}"
  echo "✓ Deleted ${PARAM} — lifecycle notifications are off."
  exit 0
fi

if [[ "${ARG}" != https://discord.com/api/webhooks/* ]]; then
  echo "ERROR: expected a Discord webhook URL (https://discord.com/api/webhooks/...)" >&2
  exit 1
fi

aws ssm put-parameter --name "${PARAM}" --type SecureString --value "${ARG}" --overwrite >/dev/null
echo "✓ Stored ${PARAM}. The next server event will be posted to that channel."

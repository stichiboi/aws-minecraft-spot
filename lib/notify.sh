#!/bin/bash
# Post a lifecycle message to the Discord channel webhook stored as a
# SecureString at /minecraft/secrets/discord-webhook-url (set it with
# `task set-discord-webhook`). Does nothing when the parameter is missing and
# never fails the caller.
#
# Usage: notify.sh "<message>"
set -uo pipefail

MESSAGE="${1:?Usage: notify.sh <message>}"
PARAM="/minecraft/secrets/discord-webhook-url"

if [[ -z "${AWS_DEFAULT_REGION:-}" && -f /etc/minecraft/instance.env ]]; then
  # shellcheck disable=SC1091
  source /etc/minecraft/instance.env
  export AWS_DEFAULT_REGION
fi

URL=$(aws ssm get-parameter --name "${PARAM}" --with-decryption \
  --query Parameter.Value --output text 2>/dev/null) || exit 0
[[ -n "${URL}" && "${URL}" != "None" ]] || exit 0

BODY=$(python3 -c 'import json, sys; print(json.dumps({"content": sys.argv[1][:2000]}))' "${MESSAGE}")
curl -sf -m 10 -H "Content-Type: application/json" -d "${BODY}" "${URL}" >/dev/null \
  || echo "notify: Discord webhook post failed" >&2
exit 0

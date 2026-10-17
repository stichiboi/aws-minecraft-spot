#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: rcon.sh <instance-id> <command...>}"
shift
COMMAND="$*"

if [[ -z "${COMMAND}" ]]; then
  echo "Usage: rcon.sh <instance-id> <command>" >&2
  exit 1
fi

echo "RCON: ${COMMAND}"

# Build the remote script. Only ${COMMAND} is expanded here (on the dev machine);
# everything else uses \${...} so it expands on the EC2 instance.
REMOTE_SCRIPT=$(cat <<EOF
set -euo pipefail
SERVER_DIR=/opt/minecraft/data/server
get_prop() {
  grep -E "^\$1=" "\${SERVER_DIR}/server.properties" \\
    | head -1 | cut -d'=' -f2- | tr -d '[:space:]'
}
RCON_PORT=\$(get_prop "rcon.port")
RCON_PASSWORD=\$(get_prop "rcon.password")
RCON_PORT="\${RCON_PORT:-25575}"
if [[ -z "\${RCON_PASSWORD}" ]]; then
  echo "ERROR: rcon.password not set in server.properties" >&2
  exit 1
fi
python3 /opt/minecraft/rcon_query.py "\${RCON_PORT}" "\${RCON_PASSWORD}" "${COMMAND}"
EOF
)

source "$(dirname "${BASH_SOURCE[0]}")/lib/ssm-run.sh"

ssm_run "${INSTANCE_ID}" "$(json_array "${REMOTE_SCRIPT}")"

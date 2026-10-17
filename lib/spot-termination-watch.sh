#!/bin/bash
# Poll IMDS for spot capacity-reclaim notice; warn players and run graceful
# shutdown when seen. AWS gives a 2-minute notice, so poll often.
set -euo pipefail

LOG_TAG="spot-termination-watch"
POLL_INTERVAL=5
IMDS="http://169.254.169.254"
GRACEFUL="/opt/minecraft/graceful-shutdown.sh"
RCON_HELPER="/opt/minecraft/rcon_query.py"
SERVER_PROPS="/opt/minecraft/data/server/server.properties"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [${LOG_TAG}] $*"; }

imds_token() {
  curl -sf -X PUT "${IMDS}/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300"
}

get_prop() {
  grep -E "^$1=" "${SERVER_PROPS}" 2>/dev/null \
    | head -1 | cut -d'=' -f2- | tr -d '[:space:]'
}

warn_players() {
  [[ "$(get_prop "enable-rcon")" == "true" ]] || return 0
  local port password
  port=$(get_prop "rcon.port")
  password=$(get_prop "rcon.password")
  [[ -n "${password}" ]] || return 0
  timeout 5 python3 "${RCON_HELPER}" "${port:-25575}" "${password}" \
    "say AWS is reclaiming this server in under 2 minutes - saving the world now" \
    >/dev/null 2>&1 || true
}

log "Spot termination watcher started (poll every ${POLL_INTERVAL}s)"

while true; do
  TOKEN=$(imds_token) || { sleep "${POLL_INTERVAL}"; continue; }

  TERMINATION=$(curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" \
    "${IMDS}/latest/meta-data/spot/termination-time" 2>/dev/null || true)

  if [[ -n "${TERMINATION}" ]]; then
    log "Spot termination notice received (deadline: ${TERMINATION})"
    warn_players
    "${GRACEFUL}" || log "WARN: graceful shutdown returned non-zero"
    log "Graceful shutdown complete — waiting for instance termination"
    exit 0
  fi

  sleep "${POLL_INTERVAL}"
done

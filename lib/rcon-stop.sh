#!/bin/bash
# ExecStop for minecraft.service. Asks the server to save and exit over RCON.
# Always exits 0: if RCON is off or fails, systemd SIGTERMs the JVM, which
# saves as it exits. Must not call systemctl — this runs inside the stop job.
set -u

SERVER_DIR="/opt/minecraft/data/server"
RCON_HELPER="/opt/minecraft/rcon_query.py"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [rcon-stop] $*"; }

get_prop() {
  grep -E "^$1=" "${SERVER_DIR}/server.properties" 2>/dev/null \
    | head -1 | cut -d'=' -f2- | tr -d '[:space:]'
}

if [[ "$(get_prop "enable-rcon")" != "true" ]]; then
  log "RCON disabled — leaving the stop to SIGTERM"
  exit 0
fi

port=$(get_prop "rcon.port")
password=$(get_prop "rcon.password")
port="${port:-25575}"
if [[ -z "${password}" ]]; then
  log "RCON password unset — leaving the stop to SIGTERM"
  exit 0
fi

log "Sending RCON save-all"
timeout 15 python3 "${RCON_HELPER}" "${port}" "${password}" "save-all" \
  || log "WARN: save-all failed"

log "Sending RCON stop"
timeout 15 python3 "${RCON_HELPER}" "${port}" "${password}" "stop" \
  || log "WARN: stop failed"

exit 0

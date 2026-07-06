#!/bin/bash
# Gracefully stop Minecraft: RCON save-all + stop, then systemctl fallback.
# Safe to call concurrently — serialised via flock.
set -euo pipefail

LOG_TAG="graceful-shutdown"
LOCK_FILE="/run/minecraft-graceful-shutdown.lock"
SERVER_DIR="/opt/minecraft/data/server"
RCON_HELPER="/opt/minecraft/rcon_query.py"
STOP_TIMEOUT=120

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [${LOG_TAG}] $*"; }

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log "Another graceful shutdown in progress — waiting..."
  flock 9
fi

if ! systemctl is-active --quiet minecraft.service; then
  log "minecraft.service already inactive — nothing to do"
  exit 0
fi

get_prop() {
  grep -E "^$1=" "${SERVER_DIR}/server.properties" \
    | head -1 | cut -d'=' -f2- | tr -d '[:space:]'
}

wait_for_service_stop() {
  local elapsed=0
  while systemctl is-active --quiet minecraft.service; do
    if [[ "${elapsed}" -ge "${STOP_TIMEOUT}" ]]; then
      return 1
    fi
    sleep 2
    elapsed=$(( elapsed + 2 ))
  done
  return 0
}

try_rcon_shutdown() {
  [[ "$(get_prop "enable-rcon")" == "true" ]] || return 1

  local port password
  port=$(get_prop "rcon.port")
  password=$(get_prop "rcon.password")
  port="${port:-25575}"
  [[ -n "${password}" ]] || return 1

  log "Sending RCON save-all..."
  timeout 15 python3 "${RCON_HELPER}" "${port}" "${password}" "save-all" >/dev/null 2>&1 || return 1

  log "Sending RCON stop..."
  timeout 15 python3 "${RCON_HELPER}" "${port}" "${password}" "stop" >/dev/null 2>&1 || return 1

  log "Waiting for minecraft.service to stop (RCON)..."
  wait_for_service_stop
}

log "Starting graceful Minecraft shutdown"

if try_rcon_shutdown; then
  log "Minecraft stopped via RCON"
  exit 0
fi

log "RCON shutdown failed or unavailable — stopping via systemctl"
systemctl stop minecraft.service || true

if wait_for_service_stop; then
  log "Minecraft stopped via systemctl"
  exit 0
fi

log "ERROR: minecraft.service still active after ${STOP_TIMEOUT}s"
exit 1

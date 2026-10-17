#!/bin/bash
# Idle shutdown monitor: counts online players and invokes the stop Lambda
# after SHUTDOWN_TIMER seconds with nobody online. Players are counted via
# RCON /list; when RCON is disabled or unreachable it falls back to counting
# established TCP connections on the game port.
#
# Env (from /etc/minecraft/instance.env): MINECRAFT_PORT, SHUTDOWN_TIMER,
# MANAGEMENT_FUNCTION, AWS_DEFAULT_REGION, FQDN.
set -euo pipefail

: "${MINECRAFT_PORT:?}" "${SHUTDOWN_TIMER:?}" "${MANAGEMENT_FUNCTION:?}" \
  "${AWS_DEFAULT_REGION:?}" "${FQDN:?}"
export AWS_DEFAULT_REGION

MC_DATA="/opt/minecraft/data"
SERVER_DIR="${MC_DATA}/server"
RCON_HELPER="/opt/minecraft/rcon_query.py"
NOTIFY="/opt/minecraft/notify.sh"
LOG_TAG="minecraft-monitor"

CHECK_INTERVAL=30
RCON_TIMEOUT=15
# After this many seconds of consecutive RCON failures, fall back to TCP counting.
RCON_FAIL_GRACE=300
# How long to wait for the server to come up before starting the idle timer anyway.
READY_TIMEOUT=600
# Written by graceful-shutdown.sh; the stop Lambda should terminate us within this window.
GRACEFUL_MARKER="/run/minecraft-graceful-shutdown"
GRACEFUL_STOP_GRACE=300

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [${LOG_TAG}] $*"; }

log "Waiting for server.properties..."
for attempt in $(seq 1 120); do
  [[ -f "${SERVER_DIR}/server.properties" ]] && break
  sleep 5
done

if [[ ! -f "${SERVER_DIR}/server.properties" ]]; then
  log "ERROR: server.properties not found after 10 minutes — exiting"
  exit 1
fi

get_prop() {
  grep -E "^$1=" "${SERVER_DIR}/server.properties" \
    | head -1 | cut -d'=' -f2- | tr -d '[:space:]'
}

if [[ "$(get_prop "enable-rcon")" == "true" && -n "$(get_prop "rcon.password")" ]]; then
  MODE="rcon"
else
  MODE="tcp"
  log "RCON not configured — counting TCP connections on port ${MINECRAFT_PORT} instead"
fi

if [[ "${SHUTDOWN_TIMER}" =~ ^[0-9]+$ ]] && [[ "${SHUTDOWN_TIMER}" -gt 0 ]]; then
  :
else
  SHUTDOWN_TIMER=900
fi
log "Idle shutdown timer: ${SHUTDOWN_TIMER}s ($(( SHUTDOWN_TIMER / 60 ))m)"

# Prints player count (>= 0) or -1 if RCON is unreachable
rcon_player_count() {
  local port password count
  port=$(get_prop "rcon.port")
  password=$(get_prop "rcon.password")
  count=$(timeout "${RCON_TIMEOUT}" python3 "${RCON_HELPER}" "${port:-25575}" "${password}" 2>/dev/null) || {
    echo "-1"
    return 0
  }
  if [[ "${count}" =~ ^[0-9]+$ ]]; then
    echo "${count}"
  else
    echo "-1"
  fi
}

tcp_player_count() {
  ss -Htn state established "( sport = :${MINECRAFT_PORT} )" | wc -l | tr -d ' '
}

server_ready() {
  if [[ "${MODE}" == "rcon" ]]; then
    [[ "$(rcon_player_count)" != "-1" ]]
  else
    ss -Hltn "( sport = :${MINECRAFT_PORT} )" | grep -q .
  fi
}

# Sets PLAYERS to the current count, or -1 while RCON is failing within the grace period.
rcon_fail_since=0
measure_players() {
  if [[ "${MODE}" == "tcp" ]]; then
    PLAYERS=$(tcp_player_count)
    return
  fi
  PLAYERS=$(rcon_player_count)
  if [[ "${PLAYERS}" != "-1" ]]; then
    rcon_fail_since=0
    return
  fi
  local now fail_elapsed
  now=$(date +%s)
  [[ "${rcon_fail_since}" -eq 0 ]] && rcon_fail_since="${now}"
  fail_elapsed=$(( now - rcon_fail_since ))
  if [[ "${fail_elapsed}" -lt "${RCON_FAIL_GRACE}" ]]; then
    log "WARN: RCON unreachable — grace ${fail_elapsed}s/${RCON_FAIL_GRACE}s"
    return
  fi
  PLAYERS=$(tcp_player_count)
  log "WARN: RCON unreachable for ${fail_elapsed}s — using TCP connection count (${PLAYERS})"
}

do_shutdown() {
  log "Invoking stop Lambda ${MANAGEMENT_FUNCTION}"
  timeout 120 aws lambda invoke \
    --function-name "${MANAGEMENT_FUNCTION}" \
    --payload '{"commandName":"stop"}' \
    --cli-binary-format raw-in-base64-out \
    /tmp/monitor-lambda-response.json \
    && log "Lambda response: $(cat /tmp/monitor-lambda-response.json)" \
    || log "WARN: Lambda invoke failed — instance may need manual cleanup"
}

log "Waiting for Minecraft to accept connections (${MODE})..."
ready=false
for attempt in $(seq 1 $(( READY_TIMEOUT / 10 ))); do
  if server_ready; then
    ready=true
    break
  fi
  sleep 10
done

if [[ "${ready}" == "true" ]]; then
  log "Server ready"
  "${NOTIFY}" "✅ **Server is ready** — connect to \`${FQDN}\`"
else
  log "WARN: server not ready after ${READY_TIMEOUT}s — starting idle timer anyway"
fi

last_activity=$(date +%s)

log "Monitor started — checking every ${CHECK_INTERVAL}s, shutting down after ${SHUTDOWN_TIMER}s idle"

while true; do
  if ! systemctl is-active --quiet minecraft.service; then
    # A graceful shutdown (stop Lambda, spot reclaim) is already terminating the
    # instance; only step in if it hasn't happened within the grace period.
    if [[ -f "${GRACEFUL_MARKER}" ]] \
      && (( $(date +%s) - $(stat -c %Y "${GRACEFUL_MARKER}") < GRACEFUL_STOP_GRACE )); then
      log "minecraft.service stopped by graceful shutdown — waiting for termination"
      sleep "${CHECK_INTERVAL}"
      continue
    fi
    if [[ -f "${GRACEFUL_MARKER}" ]]; then
      log "Instance still alive ${GRACEFUL_STOP_GRACE}s after graceful shutdown — invoking stop again"
    else
      log "minecraft.service inactive — initiating shutdown"
      "${NOTIFY}" "⚠️ **Minecraft stopped unexpectedly** — shutting the server down. Check \`task logs\` next time it's up."
    fi
    do_shutdown
    break
  fi

  measure_players

  if [[ "${PLAYERS}" == "-1" ]]; then
    sleep "${CHECK_INTERVAL}"
    continue
  fi

  if [[ "${PLAYERS}" -gt 0 ]]; then
    log "${PLAYERS} player(s) online — idle timer reset"
    last_activity=$(date +%s)
  else
    elapsed=$(( $(date +%s) - last_activity ))
    remaining=$(( SHUTDOWN_TIMER - elapsed ))
    log "No players online — idle for ${elapsed}s, shutdown in ${remaining}s"

    if [[ "${elapsed}" -ge "${SHUTDOWN_TIMER}" ]]; then
      log "Idle timeout reached"
      "${NOTIFY}" "💤 No players for $(( SHUTDOWN_TIMER / 60 )) min — stopping the server. Use \`/start\` to bring it back."
      do_shutdown
      break
    fi
  fi

  sleep "${CHECK_INTERVAL}"
done

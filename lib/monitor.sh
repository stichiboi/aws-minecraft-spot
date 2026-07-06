#!/bin/bash
# Idle shutdown monitor: polls RCON, shuts down after inactivity.
set -euo pipefail

MC_DATA="/opt/minecraft/data"
SERVER_DIR="${MC_DATA}/server"
RCON_HELPER="/opt/minecraft/rcon_query.py"
LOG_TAG="minecraft-monitor"

CHECK_INTERVAL=30
RCON_TIMEOUT=15
# After this many seconds of consecutive RCON failures, treat as 0 players.
RCON_FAIL_GRACE=300

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

read_rcon_config() {
  RCON_PORT=$(get_prop "rcon.port")
  RCON_PASSWORD=$(get_prop "rcon.password")
  RCON_PORT="${RCON_PORT:-25575}"
}

RCON_ENABLED=$(get_prop "enable-rcon")
if [[ "${RCON_ENABLED}" != "true" ]]; then
  log "RCON is disabled in server.properties — idle monitor cannot run"
  exit 0
fi

read_rcon_config

if [[ -z "${RCON_PASSWORD}" ]]; then
  log "ERROR: rcon.password not set in server.properties — exiting"
  exit 1
fi

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
REGION=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/placement/region)
export AWS_DEFAULT_REGION="${REGION}"

SSM_TIMER=$(aws ssm get-parameter \
  --name "/minecraft/config/shutdown-timer" \
  --query "Parameter.Value" \
  --output text 2>/dev/null || echo "")

if [[ "${SSM_TIMER}" =~ ^[0-9]+$ ]] && [[ "${SSM_TIMER}" -gt 0 ]]; then
  SHUTDOWN_TIMER="${SSM_TIMER}"
else
  SHUTDOWN_TIMER=900
fi

log "Idle shutdown timer: ${SHUTDOWN_TIMER}s ($(( SHUTDOWN_TIMER / 60 ))m)"

# Returns player count (>= 0) or -1 if RCON is unreachable
rcon_player_count() {
  local count
  count=$(timeout "${RCON_TIMEOUT}" python3 "${RCON_HELPER}" "${RCON_PORT}" "${RCON_PASSWORD}" 2>/dev/null) || {
    echo "-1"
    return 0
  }
  if [[ "${count}" =~ ^[0-9]+$ ]]; then
    echo "${count}"
  else
    echo "-1"
  fi
}

do_shutdown() {
  log "Idle timeout reached — invoking stop Lambda"
  timeout 120 aws lambda invoke \
    --function-name minecraft-server-management \
    --payload '{"commandName":"stop"}' \
    --cli-binary-format raw-in-base64-out \
    /tmp/monitor-lambda-response.json \
    && log "Lambda response: $(cat /tmp/monitor-lambda-response.json)" \
    || log "WARN: Lambda invoke failed — instance may need manual cleanup"
}

log "Waiting for Minecraft RCON on port ${RCON_PORT}..."
for attempt in $(seq 1 60); do
  read_rcon_config
  count=$(rcon_player_count)
  if [[ "${count}" != "-1" ]]; then
    log "RCON ready — ${count} player(s) currently online"
    break
  fi
  sleep 10
done

last_activity=$(date +%s)
rcon_fail_since=0

log "Monitor started — checking every ${CHECK_INTERVAL}s, shutting down after ${SHUTDOWN_TIMER}s idle"

while true; do
  read_rcon_config

  if [[ -z "${RCON_PASSWORD}" ]]; then
    log "ERROR: rcon.password not set — exiting"
    exit 1
  fi

  if ! systemctl is-active --quiet minecraft.service; then
    log "minecraft.service inactive — initiating shutdown"
    do_shutdown
    break
  fi

  count=$(rcon_player_count)

  if [[ "${count}" == "-1" ]]; then
    now=$(date +%s)
    if [[ "${rcon_fail_since}" -eq 0 ]]; then
      rcon_fail_since="${now}"
    fi
    fail_elapsed=$(( now - rcon_fail_since ))
    if [[ "${fail_elapsed}" -lt "${RCON_FAIL_GRACE}" ]]; then
      remaining_grace=$(( RCON_FAIL_GRACE - fail_elapsed ))
      log "WARN: RCON unreachable — grace ${fail_elapsed}s/${RCON_FAIL_GRACE}s (${remaining_grace}s until fail-closed)"
      sleep "${CHECK_INTERVAL}"
      continue
    fi
    log "WARN: RCON unreachable for ${fail_elapsed}s — treating as no players (fail-closed)"
    count=0
  else
    rcon_fail_since=0
  fi

  if [[ "${count}" -gt 0 ]]; then
    log "${count} player(s) online — idle timer reset"
    last_activity=$(date +%s)
  else
    elapsed=$(( $(date +%s) - last_activity ))
    remaining=$(( SHUTDOWN_TIMER - elapsed ))
    log "No players online — idle for ${elapsed}s, shutdown in ${remaining}s"

    if [[ "${elapsed}" -ge "${SHUTDOWN_TIMER}" ]]; then
      do_shutdown
      break
    fi
  fi

  sleep "${CHECK_INTERVAL}"
done

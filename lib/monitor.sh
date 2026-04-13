#!/bin/bash
# Idle shutdown monitor: polls RCON, shuts down after inactivity.
set -euo pipefail

MC_DATA="/opt/minecraft/data"
SERVER_DIR="${MC_DATA}/server"
RCON_HELPER="/opt/minecraft/rcon_query.py"
LOG_TAG="minecraft-monitor"

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

RCON_ENABLED=$(get_prop "enable-rcon")
if [[ "${RCON_ENABLED}" != "true" ]]; then
  log "RCON is disabled in server.properties — idle monitor cannot run"
  exit 0
fi

RCON_PORT=$(get_prop "rcon.port")
RCON_PASSWORD=$(get_prop "rcon.password")
RCON_PORT="${RCON_PORT:-25575}"

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
  count=$(python3 "${RCON_HELPER}" "${RCON_PORT}" "${RCON_PASSWORD}" 2>/dev/null) || {
    echo "-1"
    return 0
  }
  if [[ "${count}" =~ ^[0-9]+$ ]]; then
    echo "${count}"
  else
    echo "-1"
  fi
}

log "Waiting for Minecraft RCON on port ${RCON_PORT}..."
for attempt in $(seq 1 60); do
  count=$(rcon_player_count)
  if [[ "${count}" != "-1" ]]; then
    log "RCON ready — ${count} player(s) currently online"
    break
  fi
  sleep 10
done

CHECK_INTERVAL=30
last_activity=$(date +%s)

log "Monitor started — checking every ${CHECK_INTERVAL}s, shutting down after ${SHUTDOWN_TIMER}s idle"

while true; do
  count=$(rcon_player_count)

  if [[ "${count}" == "-1" ]]; then
    log "WARN: RCON unreachable — resetting idle timer"
    last_activity=$(date +%s)
  elif [[ "${count}" -gt 0 ]]; then
    log "${count} player(s) online — idle timer reset"
    last_activity=$(date +%s)
  else
    elapsed=$(( $(date +%s) - last_activity ))
    remaining=$(( SHUTDOWN_TIMER - elapsed ))
    log "No players online — idle for ${elapsed}s, shutdown in ${remaining}s"

    if [[ "${elapsed}" -ge "${SHUTDOWN_TIMER}" ]]; then
      log "Idle timeout reached — initiating graceful shutdown"

      log "Stopping minecraft.service..."
      systemctl stop minecraft.service || true
      sleep 15

      # Invoke management Lambda to cancel spot request and terminate cleanly
      log "Invoking minecraft-server-management Lambda..."
      aws lambda invoke \
        --function-name minecraft-server-management \
        --payload '{"commandName":"stop"}' \
        --cli-binary-format raw-in-base64-out \
        /tmp/monitor-lambda-response.json \
        && log "Lambda response: $(cat /tmp/monitor-lambda-response.json)" \
        || log "WARN: Lambda invoke failed — instance may need manual cleanup"

      log "Shutdown sequence complete"
      break
    fi
  fi

  sleep "${CHECK_INTERVAL}"
done

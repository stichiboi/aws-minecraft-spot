#!/bin/bash
# Poll IMDS for spot capacity-reclaim notice; run graceful shutdown when seen.
set -euo pipefail

LOG_TAG="spot-termination-watch"
POLL_INTERVAL=30
IMDS="http://169.254.169.254"
GRACEFUL="/opt/minecraft/graceful-shutdown.sh"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [${LOG_TAG}] $*"; }

imds_token() {
  curl -sf -X PUT "${IMDS}/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300"
}

log "Spot termination watcher started (poll every ${POLL_INTERVAL}s)"

while true; do
  TOKEN=$(imds_token) || { sleep "${POLL_INTERVAL}"; continue; }

  TERMINATION=$(curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" \
    "${IMDS}/latest/meta-data/spot/termination-time" 2>/dev/null || true)

  if [[ -n "${TERMINATION}" ]]; then
    log "Spot termination notice received (deadline: ${TERMINATION})"
    "${GRACEFUL}" || log "WARN: graceful shutdown returned non-zero"
    log "Graceful shutdown complete — waiting for instance termination"
    exit 0
  fi

  sleep "${POLL_INTERVAL}"
done

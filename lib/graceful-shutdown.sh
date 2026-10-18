#!/bin/bash
# Stop Minecraft because the instance is going away (stop Lambda, spot reclaim).
# The RCON save-all/stop lives in rcon-stop.sh, the unit's ExecStop, so a
# restart saves the same way. This script only leaves the marker the idle
# monitor reads, then stops the service.
#
# Stops minecraft.service, not minecraft.target, on purpose: the idle monitor
# must keep running so it can call the stop Lambda again if termination fails,
# and the spot watcher running this script must not be stopped under it.
# Restarts go through minecraft.target instead (see README "Restart vs stop").
# Safe to call concurrently — serialised via flock.
set -euo pipefail

LOG_TAG="graceful-shutdown"
LOCK_FILE="/run/minecraft-graceful-shutdown.lock"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [${LOG_TAG}] $*"; }

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log "Another graceful shutdown in progress — waiting..."
  flock 9
fi

# Tells the idle monitor this stop is intentional (see monitor.sh).
touch /run/minecraft-graceful-shutdown

if ! systemctl is-active --quiet minecraft.service; then
  log "minecraft.service already inactive — nothing to do"
  exit 0
fi

log "Stopping minecraft.service"
if systemctl stop minecraft.service; then
  log "Minecraft stopped"
  exit 0
fi

log "ERROR: systemctl stop minecraft.service failed"
exit 1

#!/bin/bash
set -euo pipefail
cd "/opt/minecraft/data/server"

# Size the heap from instance RAM so every fleet type is used fully and safely.
# An explicit -Xmx in jvm-args.txt wins.
HEAP_ARGS=()
if ! grep -qE '^-Xmx' jvm-args.txt 2>/dev/null; then
  MEM_MB=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
  HEAP_MB=$(( MEM_MB * ${HEAP_PERCENT:-70} / 100 ))
  HEAP_ARGS=("-Xms${HEAP_MB}M" "-Xmx${HEAP_MB}M")
fi
echo "start.sh: heap ${HEAP_ARGS[*]:-from jvm-args.txt}"

UNIX_ARGS=$(find libraries -path '*/unix_args.txt' 2>/dev/null | head -1)
if [[ -n "${UNIX_ARGS}" ]]; then
  exec java "${HEAP_ARGS[@]}" @jvm-args.txt @"${UNIX_ARGS}" nogui
else
  exec java "${HEAP_ARGS[@]}" @jvm-args.txt -jar server.jar nogui
fi

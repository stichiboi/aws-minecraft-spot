#!/bin/bash
set -euo pipefail
cd "/opt/minecraft/data/server"
UNIX_ARGS=$(find libraries -path '*/unix_args.txt' 2>/dev/null | head -1)
if [[ -n "${UNIX_ARGS}" ]]; then
  exec java @jvm-args.txt @"${UNIX_ARGS}" nogui
else
  exec java @jvm-args.txt -jar server.jar nogui
fi

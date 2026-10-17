#!/bin/bash
# First-boot user data: install the per-boot bootstrap and run it once.
# Everything else lives in per-boot.sh, fetched from S3 on every boot.
set -euo pipefail

mkdir -p /var/lib/cloud/scripts/per-boot
# __BOOTSTRAP__

# cloud-init's per-boot stage runs before user data, so on the first boot the
# hook has to be started by hand.
/var/lib/cloud/scripts/per-boot/minecraft-boot.sh

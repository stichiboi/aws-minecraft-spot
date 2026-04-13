#!/bin/bash
set -euo pipefail

echo "=== Minecraft one-time setup started at $(date) ==="

dnf install -y jq nvme-cli

MC_USER="minecraft"
MC_HOME="/opt/minecraft"

if ! id "${MC_USER}" &>/dev/null; then
  useradd -r -m -d "${MC_HOME}" -s /bin/bash "${MC_USER}"
fi

mkdir -p /var/lib/cloud/scripts/per-boot
# __PER_BOOT_HEREDOC__
# __MONITOR_HEREDOC__

cat > /etc/systemd/system/minecraft.service <<'UNIT'
[Unit]
Description=Minecraft Server
After=network.target

[Service]
Type=simple
User=minecraft
WorkingDirectory=/opt/minecraft/data/server
ExecStart=/opt/minecraft/data/server/start.sh
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/minecraft-monitor.service <<'UNIT'
[Unit]
Description=Minecraft idle shutdown monitor
After=minecraft.service

[Service]
Type=simple
User=root
ExecStart=/opt/minecraft/monitor.sh
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable minecraft-monitor.service

/var/lib/cloud/scripts/per-boot/minecraft-boot.sh

echo "=== Minecraft one-time setup completed at $(date) ==="

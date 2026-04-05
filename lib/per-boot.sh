#!/bin/bash
set -euo pipefail

MC_USER="minecraft"
MC_DATA="/opt/minecraft/data"
SERVER_DIR="${MC_DATA}/server"
CONFIG_DIR="${MC_DATA}/config"
MODS_DIR="${SERVER_DIR}/mods"

exec > >(tee -a /var/log/minecraft-boot.log) 2>&1
echo "=== Minecraft per-boot script started at $(date) ==="

# ── 1. Instance metadata ─────────────────────────────────────────
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")

INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/instance-id)

PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/public-ipv4)

REGION=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/placement/region)

export AWS_DEFAULT_REGION="${REGION}"

# ── 2. System update ─────────────────────────────────────────────
dnf update -y --security

# ── 3. Read config from SSM Parameter Store ──────────────────────
CFG=$(aws ssm get-parameters-by-path \
  --path /minecraft/config \
  --output json \
  --query 'Parameters[*].{Name:Name,Value:Value}')

get_param() {
  echo "${CFG}" | jq -r --arg n "/minecraft/config/$1" '.[] | select(.Name == $n) | .Value'
}

BUCKET_NAME=$(get_param bucket-name)
VOLUME_ID=$(get_param volume-id)
HOSTED_ZONE_ID=$(get_param hosted-zone-id)
FQDN=$(get_param fqdn)
MINECRAFT_PORT=$(get_param port)

# ── 4. Attach EBS data volume if not already attached ────────────
ATTACH_STATE=$(aws ec2 describe-volumes \
  --volume-ids "${VOLUME_ID}" \
  --query "Volumes[0].Attachments[?InstanceId=='${INSTANCE_ID}'].State" \
  --output text 2>/dev/null || echo "")

if [[ "${ATTACH_STATE}" != "attached" ]]; then
  echo "Attaching volume ${VOLUME_ID} to ${INSTANCE_ID}..."
  aws ec2 attach-volume \
    --volume-id "${VOLUME_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --device /dev/sdf
  aws ec2 wait volume-in-use --volume-ids "${VOLUME_ID}"
  sleep 5
else
  echo "Volume ${VOLUME_ID} already attached."
fi

# ── 5. Find the real block device ────────────────────────────────
# On Nitro instances (r5, m5, c5, etc.) /dev/sdf maps to /dev/nvme*n1.
# We locate it via /dev/disk/by-id/ using the volume serial number.
VOLUME_ID_CLEAN="${VOLUME_ID//-/}"
REAL_DEVICE=""

for attempt in $(seq 1 30); do
  for link in /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_*; do
    if [[ -e "${link}" && "$(basename "${link}")" == *"${VOLUME_ID_CLEAN}"* ]]; then
      REAL_DEVICE=$(readlink -f "${link}")
      break 2
    fi
  done
  for dev in /dev/sdf /dev/xvdf; do
    if [[ -b "${dev}" ]]; then
      REAL_DEVICE="${dev}"
      break 2
    fi
  done
  sleep 2
done

if [[ -z "${REAL_DEVICE}" ]]; then
  echo "ERROR: Could not find block device for volume ${VOLUME_ID} after 60s"
  exit 1
fi

echo "Data volume device: ${REAL_DEVICE}"

# ── 6. Format if new (no filesystem yet) ─────────────────────────
if ! blkid -o value -s TYPE "${REAL_DEVICE}" &>/dev/null; then
  echo "New volume - formatting as xfs..."
  mkfs.xfs "${REAL_DEVICE}"
fi

# ── 7. Mount ──────────────────────────────────────────────────────
mkdir -p "${MC_DATA}"
if ! mountpoint -q "${MC_DATA}"; then
  mount "${REAL_DEVICE}" "${MC_DATA}"
  echo "Mounted ${REAL_DEVICE} at ${MC_DATA}"
fi

mkdir -p "${SERVER_DIR}" "${CONFIG_DIR}" "${MODS_DIR}"

# ── 8. Update Route53 A record ────────────────────────────────────
echo "Updating DNS: ${FQDN} -> ${PUBLIC_IP}"
aws route53 change-resource-record-sets \
  --hosted-zone-id "${HOSTED_ZONE_ID}" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"${FQDN}\",
        \"Type\": \"A\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"${PUBLIC_IP}\"}]
      }
    }]
  }"

# ── 9. Sync config from S3 ────────────────────────────────────────
aws s3 cp "s3://${BUCKET_NAME}/config/config.json" "${CONFIG_DIR}/config.json" \
  || echo '{"type":"vanilla","mcVersion":"1.20.4","loaderVersion":""}' > "${CONFIG_DIR}/config.json"

aws s3 cp "s3://${BUCKET_NAME}/config/jvm-args.txt" "${SERVER_DIR}/jvm-args.txt" \
  || printf -- '-Xms1G\n-Xmx2G\n' > "${SERVER_DIR}/jvm-args.txt"

aws s3 cp "s3://${BUCKET_NAME}/config/server.properties" "${SERVER_DIR}/server.properties" \
  || true

# ── 10. Read config ───────────────────────────────────────────────
SERVER_TYPE=$(jq -r '.type // "vanilla"' "${CONFIG_DIR}/config.json")
MC_VERSION=$(jq -r '.mcVersion // "1.20.4"' "${CONFIG_DIR}/config.json")
LOADER_VERSION=$(jq -r '.loaderVersion // ""' "${CONFIG_DIR}/config.json")
JAVA_VERSION=$(jq -r '.javaVersion // "21"' "${CONFIG_DIR}/config.json")

echo "Server: ${SERVER_TYPE} ${MC_VERSION} (loader: ${LOADER_VERSION}, java: ${JAVA_VERSION})"

# ── 11. Install Java ──────────────────────────────────────────────
dnf install -y "java-${JAVA_VERSION}-amazon-corretto-headless"

# ── 12. Install server if needed (skip if already installed) ─────
INSTALLED_MARKER="${SERVER_DIR}/.installed_${SERVER_TYPE}_${MC_VERSION}_${LOADER_VERSION}"

if [[ ! -f "${INSTALLED_MARKER}" ]]; then
  echo "Installing ${SERVER_TYPE} server..."
  rm -f "${SERVER_DIR}"/.installed_*

  install_vanilla() {
    local MANIFEST_URL="https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
    local VERSION_URL
    VERSION_URL=$(curl -s "${MANIFEST_URL}" \
      | jq -r ".versions[] | select(.id==\"${MC_VERSION}\") | .url")

    local SERVER_URL
    SERVER_URL=$(curl -s "${VERSION_URL}" | jq -r '.downloads.server.url')
    curl -sL -o "${SERVER_DIR}/server.jar" "${SERVER_URL}"
  }

  install_forge() {
    local FORGE_VER="${MC_VERSION}-${LOADER_VERSION}"
    local INSTALLER_URL="https://maven.minecraftforge.net/net/minecraftforge/forge/${FORGE_VER}/forge-${FORGE_VER}-installer.jar"

    curl -sL -o /tmp/forge-installer.jar "${INSTALLER_URL}"
    (cd "${SERVER_DIR}" && java -jar /tmp/forge-installer.jar --installServer)
    rm -f /tmp/forge-installer.jar
    [[ -f "${SERVER_DIR}/run.sh" ]] && chmod +x "${SERVER_DIR}/run.sh"
  }

  install_fabric() {
    local INSTALLER_URL="https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}/${LOADER_VERSION}/1.0.1/server/jar"
    curl -sL -o "${SERVER_DIR}/server.jar" "${INSTALLER_URL}"
  }

  install_neoforge() {
    local INSTALLER_URL="https://maven.neoforged.net/releases/net/neoforged/neoforge/${LOADER_VERSION}/neoforge-${LOADER_VERSION}-installer.jar"

    curl -sL -o /tmp/neoforge-installer.jar "${INSTALLER_URL}"
    (cd "${SERVER_DIR}" && java -jar /tmp/neoforge-installer.jar --installServer)
    rm -f /tmp/neoforge-installer.jar
    [[ -f "${SERVER_DIR}/run.sh" ]] && chmod +x "${SERVER_DIR}/run.sh"
  }

  case "${SERVER_TYPE}" in
    vanilla)  install_vanilla ;;
    forge)    install_forge ;;
    fabric)   install_fabric ;;
    neoforge) install_neoforge ;;
    *)
      echo "Unknown server type: ${SERVER_TYPE}, falling back to vanilla"
      install_vanilla
      ;;
  esac

  touch "${INSTALLED_MARKER}"
else
  echo "Server already installed - skipping."
fi

# ── 13. Sync mods from S3 ─────────────────────────────────────────
aws s3 sync "s3://${BUCKET_NAME}/mods/" "${MODS_DIR}/" --delete

# ── 14. EULA + server.properties ──────────────────────────────────
echo "eula=true" > "${SERVER_DIR}/eula.txt"

if [[ ! -f "${SERVER_DIR}/server.properties" ]]; then
  cat > "${SERVER_DIR}/server.properties" <<PROPS
server-port=${MINECRAFT_PORT}
enable-rcon=false
motd=Maincraift - powered by AWS Spot
max-players=10
view-distance=12
simulation-distance=10
PROPS
fi

sed -i "s/^server-port=.*/server-port=${MINECRAFT_PORT}/" "${SERVER_DIR}/server.properties"

# ── 15. Write launch script ───────────────────────────────────────
LAUNCH_CMD="java @jvm-args.txt -jar server.jar nogui"

if [[ -f "${SERVER_DIR}/run.sh" ]]; then
  LAUNCH_CMD="bash run.sh"
fi

cat > "${SERVER_DIR}/start.sh" <<STARTSCRIPT
#!/bin/bash
cd "${SERVER_DIR}"
exec ${LAUNCH_CMD}
STARTSCRIPT
chmod +x "${SERVER_DIR}/start.sh"

# ── 16. Fix ownership and start ───────────────────────────────────
chown -R "${MC_USER}:${MC_USER}" "${MC_DATA}"

systemctl restart minecraft.service

echo "=== Minecraft per-boot script completed at $(date) ==="

#!/bin/bash
set -euo pipefail

MC_USER="minecraft"
MC_DATA="/opt/minecraft/data"
SERVER_DIR="${MC_DATA}/server"
MODS_DIR="${SERVER_DIR}/mods"

exec > >(tee -a /var/log/minecraft-boot.log) 2>&1
echo "=== Minecraft per-boot script started at $(date) ==="

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/instance-id)
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/public-ipv4)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  http://169.254.169.254/latest/meta-data/placement/region)
export AWS_DEFAULT_REGION="${REGION}"

dnf update -y --security

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
JAVA_VERSION=$(get_param java-version)
JAVA_VERSION="${JAVA_VERSION:-21}"

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

# Nitro instances remap /dev/sdf to /dev/nvme*n1; find via volume serial
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

if ! blkid -o value -s TYPE "${REAL_DEVICE}" &>/dev/null; then
  echo "New volume — formatting as xfs..."
  mkfs.xfs "${REAL_DEVICE}"
fi

mkdir -p "${MC_DATA}"
if ! mountpoint -q "${MC_DATA}"; then
  mount "${REAL_DEVICE}" "${MC_DATA}"
  echo "Mounted ${REAL_DEVICE} at ${MC_DATA}"
fi

mkdir -p "${SERVER_DIR}" "${MODS_DIR}" "${SERVER_DIR}/config"

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

aws s3 cp "s3://${BUCKET_NAME}/server/jvm-args.txt" "${SERVER_DIR}/jvm-args.txt" \
  || printf -- '-Xms1G\n-Xmx2G\n' > "${SERVER_DIR}/jvm-args.txt"

aws s3 cp "s3://${BUCKET_NAME}/server/server.properties" "${SERVER_DIR}/server.properties" \
  || true

echo "Java version: ${JAVA_VERSION}"
dnf install -y "java-${JAVA_VERSION}-amazon-corretto-headless"

echo "Syncing server files from S3..."
aws s3 sync "s3://${BUCKET_NAME}/server-bin/" "${SERVER_DIR}/" \
  --exclude "mods/*" --exclude "world/*" --exclude "config/*"

aws s3 sync "s3://${BUCKET_NAME}/mods/" "${MODS_DIR}/" --delete
aws s3 sync "s3://${BUCKET_NAME}/mods-config/" "${SERVER_DIR}/config/" --delete
aws s3 cp "s3://${BUCKET_NAME}/tools/rcon_query.py" /opt/minecraft/rcon_query.py
aws s3 cp "s3://${BUCKET_NAME}/tools/status_query.py" /opt/minecraft/status_query.py
chmod +x /opt/minecraft/rcon_query.py /opt/minecraft/status_query.py

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

chown -R "${MC_USER}:${MC_USER}" "${MC_DATA}"

systemctl restart minecraft.service
systemctl restart minecraft-monitor.service

echo "=== Minecraft per-boot script completed at $(date) ==="

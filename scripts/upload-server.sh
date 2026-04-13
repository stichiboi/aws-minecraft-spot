#!/bin/bash
# Downloads the Minecraft server JAR (+ libraries for forge/neoforge) and
# uploads everything to S3. The EC2 instance syncs these files at boot.
# Reads server type + versions from server-config/config.json.
#
# Usage: upload-server.sh <bucket-name>
set -euo pipefail

BUCKET_NAME="${1:?Usage: install-server.sh <bucket-name>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
CONFIG_FILE="${PROJECT_DIR}/server-config/config.json"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "${WORK_DIR}"' EXIT

SERVER_TYPE=$(jq -r '.type // "vanilla"' "${CONFIG_FILE}")
MC_VERSION=$(jq -r '.mcVersion // "1.20.4"' "${CONFIG_FILE}")
LOADER_VERSION=$(jq -r '.loaderVersion // ""' "${CONFIG_FILE}")
JAVA_VERSION=$(jq -r '.javaVersion // "21"' "${CONFIG_FILE}")

echo "▸ Server: ${SERVER_TYPE} ${MC_VERSION} (loader: ${LOADER_VERSION}, java: ${JAVA_VERSION})"
echo "▸ Working directory: ${WORK_DIR}"

install_vanilla() {
  local MANIFEST_URL="https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
  local VERSION_URL
  VERSION_URL=$(curl -s "${MANIFEST_URL}" \
    | jq -r ".versions[] | select(.id==\"${MC_VERSION}\") | .url")

  if [[ -z "${VERSION_URL}" || "${VERSION_URL}" == "null" ]]; then
    echo "ERROR: Minecraft version ${MC_VERSION} not found in version manifest"
    exit 1
  fi

  local SERVER_URL
  SERVER_URL=$(curl -s "${VERSION_URL}" | jq -r '.downloads.server.url')
  echo "▸ Downloading vanilla server.jar..."
  curl -sL -o "${WORK_DIR}/server.jar" "${SERVER_URL}"
}

install_forge() {
  local FORGE_VER="${MC_VERSION}-${LOADER_VERSION}"
  local INSTALLER_URL="https://maven.minecraftforge.net/net/minecraftforge/forge/${FORGE_VER}/forge-${FORGE_VER}-installer.jar"

  echo "▸ Downloading Forge installer..."
  curl -sL -o "${WORK_DIR}/forge-installer.jar" "${INSTALLER_URL}"
  echo "▸ Running Forge installer..."
  (cd "${WORK_DIR}" && java -jar forge-installer.jar --installServer)
  rm -f "${WORK_DIR}/forge-installer.jar"
  [[ -f "${WORK_DIR}/run.sh" ]] && chmod +x "${WORK_DIR}/run.sh"
}

install_fabric() {
  local INSTALLER_URL="https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}/${LOADER_VERSION}/1.0.1/server/jar"
  echo "▸ Downloading Fabric server.jar..."
  curl -sL -o "${WORK_DIR}/server.jar" "${INSTALLER_URL}"
}

install_neoforge() {
  local INSTALLER_URL="https://maven.neoforged.net/releases/net/neoforged/neoforge/${LOADER_VERSION}/neoforge-${LOADER_VERSION}-installer.jar"

  echo "▸ Downloading NeoForge installer..."
  curl -sL -o "${WORK_DIR}/neoforge-installer.jar" "${INSTALLER_URL}"
  echo "▸ Running NeoForge installer..."
  (cd "${WORK_DIR}" && java -jar neoforge-installer.jar --installServer)
  rm -f "${WORK_DIR}/neoforge-installer.jar"
  [[ -f "${WORK_DIR}/run.sh" ]] && chmod +x "${WORK_DIR}/run.sh"
}

case "${SERVER_TYPE}" in
  vanilla)  install_vanilla ;;
  forge)    install_forge ;;
  fabric)   install_fabric ;;
  neoforge) install_neoforge ;;
  *)
    echo "ERROR: Unknown server type: ${SERVER_TYPE}"
    exit 1
    ;;
esac

echo ""
echo "▸ Uploading server files to s3://${BUCKET_NAME}/server-bin/..."
aws s3 sync "${WORK_DIR}/" "s3://${BUCKET_NAME}/server-bin/" --delete

echo ""
echo "✓ Server JAR ${SERVER_TYPE} ${MC_VERSION} uploaded to S3."

# Also upload server config (server.properties, jvm-args.txt, rcon_query.py)
bash "${SCRIPT_DIR}/upload-server-config.sh" "${BUCKET_NAME}"

echo "  Next deploy or reboot will pick it up automatically."

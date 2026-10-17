/**
 * Names shared by the CDK stacks, the Lambdas (via env vars) and the EC2 boot
 * scripts (via SSM parameters under SSM_CONFIG_PATH).
 */
export const INSTANCE_NAME_TAG = "MinecraftServer";
export const DATA_VOLUME_NAME_TAG = "MinecraftData";
export const LAUNCH_TEMPLATE_NAME = "MinecraftServer";
export const SERVER_MANAGEMENT_FUNCTION_NAME = "minecraft-server-management";

/** Plain config written by CDK, read by per-boot.sh and the API stack. */
export const SSM_CONFIG_PATH = "/minecraft/config";
/** SecureString values created by hand (`task set-discord-webhook`), never by CDK. */
export const SSM_SECRETS_PATH = "/minecraft/secrets";

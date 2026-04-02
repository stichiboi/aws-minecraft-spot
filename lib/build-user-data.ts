import * as fs from "fs";
import * as path from "path";
import {
  interpolateUserDataScript,
  stripCfnSubEscapes,
} from "./interpolate-user-data";

/** Placeholders shared by `per-boot.sh` and `user-data.sh` (via interpolation). */
export const USER_DATA_PLACEHOLDER_KEYS = [
  "BUCKET_NAME",
  "HOSTED_ZONE_ID",
  "FQDN",
  "MINECRAFT_PORT",
  "VOLUME_ID",
] as const;

/** Keys in `Fn.sub(userDataTemplate, { … })` in `minecraft-stack.ts` (per-boot is base64, not listed here). */
export const USER_DATA_OUTER_FN_SUB_KEYS = ["PER_BOOT_SCRIPT_B64"] as const;

export type UserDataPlaceholderKey = (typeof USER_DATA_PLACEHOLDER_KEYS)[number];

export type UserDataPlaceholders = Record<UserDataPlaceholderKey, string>;

export interface BuildUserDataOptions {
  readonly placeholders: Record<string, string>;
  /**
   * Directory that contains `per-boot.sh` and `user-data.sh`.
   * Default: directory of this module (`lib/` when run via ts-node from the repo).
   */
  readonly templatesDir?: string;
}

export interface UserDataBundle {
  /** Rendered per-boot script (same bytes that are base64-encoded for the instance). */
  readonly perBootScript: string;
  readonly perBootBase64: string;
  /** Full one-time user-data shell script (cloud-init first boot). */
  readonly userDataScript: string;
}

const PER_BOOT_FILE = "per-boot.sh";
const USER_DATA_FILE = "user-data.sh";

/**
 * Reads template shell files, applies `${KEY}` substitution, base64-embeds per-boot
 * into user-data (see `user-data.sh`). Used by the CDK stack and by
 * `scripts/render-user-data.ts` for local inspection.
 */
export function buildUserDataBundle(options: BuildUserDataOptions): UserDataBundle {
  const templatesDir = options.templatesDir ?? __dirname;

  const perBootRaw = fs.readFileSync(
    path.join(templatesDir, PER_BOOT_FILE),
    "utf-8"
  );
  const perBootScript = stripCfnSubEscapes(
    interpolateUserDataScript(perBootRaw, options.placeholders)
  );
  const perBootBase64 = Buffer.from(perBootScript).toString("base64");

  const userDataRaw = fs.readFileSync(
    path.join(templatesDir, USER_DATA_FILE),
    "utf-8"
  );
  const userDataScript = stripCfnSubEscapes(
    interpolateUserDataScript(userDataRaw, options.placeholders)
  ).replace(/\$\{PER_BOOT_SCRIPT_B64\}/g, perBootBase64);

  return { perBootScript, perBootBase64, userDataScript };
}

/** Example values for CLI / docs (not real AWS resources). */
export const EXAMPLE_USER_DATA_PLACEHOLDERS: UserDataPlaceholders = {
  BUCKET_NAME: "my-minecraft-mods-bucket",
  HOSTED_ZONE_ID: "Z000EXAMPLE0000",
  FQDN: "mc.example.com",
  MINECRAFT_PORT: "25565",
  VOLUME_ID: "vol-0decafbad0000",
};

import * as fs from "fs";
import * as path from "path";

export interface BuildUserDataOptions {
  /** Directory containing `per-boot.sh` and `user-data.sh`. Defaults to this module's directory. */
  readonly templatesDir?: string;
}

/**
 * Reads the two boot scripts and embeds per-boot.sh as base64 inside user-data.sh.
 * No CDK token substitution is needed here — the per-boot script reads all runtime
 * config from SSM Parameter Store at boot time.
 */
export function buildUserDataBundle(
  options: BuildUserDataOptions
): { userDataScript: string } {
  const dir = options.templatesDir ?? __dirname;
  const perBootScript = fs.readFileSync(path.join(dir, "per-boot.sh"), "utf-8");
  const userDataTemplate = fs.readFileSync(
    path.join(dir, "user-data.sh"),
    "utf-8"
  );
  const userDataScript = userDataTemplate.replace(
    "${PER_BOOT_SCRIPT_B64}",
    Buffer.from(perBootScript).toString("base64")
  );
  return { userDataScript };
}

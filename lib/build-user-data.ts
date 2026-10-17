import * as fs from "fs";
import * as path from "path";

export interface BuildUserDataOptions {
  /** Directory containing `user-data.sh` and `boot-bootstrap.sh`. Defaults to this module's directory. */
  readonly templatesDir?: string;
}

export const BOOTSTRAP_PATH = "/var/lib/cloud/scripts/per-boot/minecraft-boot.sh";

/**
 * Embeds boot-bootstrap.sh as a quoted heredoc inside user-data.sh.
 * Quoted heredoc delimiters prevent variable/command expansion.
 */
export function buildUserDataBundle(
  options: BuildUserDataOptions
): { userDataScript: string } {
  const dir = options.templatesDir ?? __dirname;
  const userDataTemplate = fs.readFileSync(path.join(dir, "user-data.sh"), "utf-8");
  const bootstrap = fs.readFileSync(path.join(dir, "boot-bootstrap.sh"), "utf-8");

  const bootstrapHeredoc = [
    `cat > ${BOOTSTRAP_PATH} <<'BOOTSTRAPEOF'`,
    bootstrap.trimEnd(),
    "BOOTSTRAPEOF",
    `chmod +x ${BOOTSTRAP_PATH}`,
  ].join("\n");

  const userDataScript = userDataTemplate.replace("# __BOOTSTRAP__", bootstrapHeredoc);

  return { userDataScript };
}

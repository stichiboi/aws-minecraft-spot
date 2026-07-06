import * as fs from "fs";
import * as path from "path";

export interface BuildUserDataOptions {
  /** Directory containing boot scripts and `user-data.sh`. Defaults to this module's directory. */
  readonly templatesDir?: string;
}

function embedScript(dir: string, filename: string, destPath: string): string {
  const script = fs.readFileSync(path.join(dir, filename), "utf-8");
  const delimiter = filename.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "EOF";
  return [
    `cat > ${destPath} <<'${delimiter}'`,
    script.trimEnd(),
    delimiter,
    `chmod +x ${destPath}`,
  ].join("\n");
}

/**
 * Reads the boot scripts and embeds them as heredocs inside user-data.sh.
 * Quoted heredoc delimiters prevent variable/command expansion.
 */
export function buildUserDataBundle(
  options: BuildUserDataOptions
): { userDataScript: string } {
  const dir = options.templatesDir ?? __dirname;
  const userDataTemplate = fs.readFileSync(path.join(dir, "user-data.sh"), "utf-8");

  const perBootHeredoc = [
    "cat > /var/lib/cloud/scripts/per-boot/minecraft-boot.sh <<'PERBOOTEOF'",
    fs.readFileSync(path.join(dir, "per-boot.sh"), "utf-8").trimEnd(),
    "PERBOOTEOF",
    "chmod +x /var/lib/cloud/scripts/per-boot/minecraft-boot.sh",
  ].join("\n");

  const embeddedScripts = [
    embedScript(dir, "monitor.sh", "/opt/minecraft/monitor.sh"),
  ].join("\n");

  const userDataScript = userDataTemplate
    .replace("# __PER_BOOT_HEREDOC__", perBootHeredoc)
    .replace("# __EMBEDDED_SCRIPTS__", embeddedScripts);

  return { userDataScript };
}

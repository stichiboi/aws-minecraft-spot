import * as fs from "fs";
import * as path from "path";

export interface BuildUserDataOptions {
  /** Directory containing `per-boot.sh`, `monitor.sh`, and `user-data.sh`. Defaults to this module's directory. */
  readonly templatesDir?: string;
}

/**
 * Reads the boot scripts and embeds per-boot.sh and monitor.sh as heredocs
 * inside user-data.sh. Quoted heredoc delimiters (<<'EOF') prevent any
 * variable/command expansion, so the scripts are embedded verbatim.
 */
export function buildUserDataBundle(
  options: BuildUserDataOptions
): { userDataScript: string } {
  const dir = options.templatesDir ?? __dirname;
  const perBootScript = fs.readFileSync(path.join(dir, "per-boot.sh"), "utf-8");
  const monitorScript = fs.readFileSync(path.join(dir, "monitor.sh"), "utf-8");
  const userDataTemplate = fs.readFileSync(path.join(dir, "user-data.sh"), "utf-8");

  const perBootHeredoc = [
    "cat > /var/lib/cloud/scripts/per-boot/minecraft-boot.sh <<'PERBOOTEOF'",
    perBootScript.trimEnd(),
    "PERBOOTEOF",
    "chmod +x /var/lib/cloud/scripts/per-boot/minecraft-boot.sh",
  ].join("\n");

  const monitorHeredoc = [
    "cat > /opt/minecraft/monitor.sh <<'MONITOREOF'",
    monitorScript.trimEnd(),
    "MONITOREOF",
    "chmod +x /opt/minecraft/monitor.sh",
  ].join("\n");

  const userDataScript = userDataTemplate
    .replace("# __PER_BOOT_HEREDOC__", perBootHeredoc)
    .replace("# __MONITOR_HEREDOC__", monitorHeredoc);

  return { userDataScript };
}

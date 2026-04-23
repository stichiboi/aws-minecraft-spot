import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { buildUserDataBundle } from "./build-user-data";

const LIB_DIR = __dirname;

describe("buildUserDataBundle", () => {
  it("embeds per-boot.sh verbatim in the per-boot heredoc", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    const perBootRaw = fs.readFileSync(
      path.join(LIB_DIR, "per-boot.sh"),
      "utf-8"
    );
    const marker = "cat > /var/lib/cloud/scripts/per-boot/minecraft-boot.sh <<'PERBOOTEOF'";
    const i = userDataScript.indexOf(marker);
    expect(i).toBeGreaterThanOrEqual(0);
    const j = userDataScript.indexOf("PERBOOTEOF", i + marker.length);
    const inner = userDataScript
      .slice(i + marker.length, j)
      .replace(/^\n/, "");
    expect(inner.trimEnd()).toBe(perBootRaw.trimEnd());
  });

  it("replaces the PER_BOOT_SCRIPT_B64 placeholder", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    expect(userDataScript).not.toContain("${PER_BOOT_SCRIPT_B64}");
  });

  it("scripts contain no CloudFormation Fn::Sub escape syntax", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    const perBootRaw = fs.readFileSync(
      path.join(LIB_DIR, "per-boot.sh"),
      "utf-8"
    );
    expect(userDataScript).not.toContain("${!");
    expect(perBootRaw).not.toContain("${!");
  });
});

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_PATH, buildUserDataBundle } from "./build-user-data";

const LIB_DIR = __dirname;

describe("buildUserDataBundle", () => {
  it("embeds boot-bootstrap.sh verbatim in the per-boot heredoc", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    const bootstrapRaw = fs.readFileSync(
      path.join(LIB_DIR, "boot-bootstrap.sh"),
      "utf-8"
    );
    const marker = `cat > ${BOOTSTRAP_PATH} <<'BOOTSTRAPEOF'`;
    const i = userDataScript.indexOf(marker);
    expect(i).toBeGreaterThanOrEqual(0);
    const j = userDataScript.indexOf("\nBOOTSTRAPEOF", i + marker.length);
    const inner = userDataScript.slice(i + marker.length, j).replace(/^\n/, "");
    expect(inner.trimEnd()).toBe(bootstrapRaw.trimEnd());
  });

  it("replaces the bootstrap placeholder", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    expect(userDataScript).not.toContain("# __BOOTSTRAP__");
  });

  it("does not embed scripts that are fetched from S3", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    for (const script of ["per-boot.sh", "monitor.sh", "graceful-shutdown.sh"]) {
      const raw = fs.readFileSync(path.join(LIB_DIR, script), "utf-8");
      expect(userDataScript).not.toContain(raw.trimEnd());
    }
  });

  it("user-data stays within EC2 16 KiB limit", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    expect(Buffer.byteLength(userDataScript, "utf8")).toBeLessThanOrEqual(16384);
  });

  it("scripts contain no CloudFormation Fn::Sub escape syntax", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    expect(userDataScript).not.toContain("${!");
  });
});

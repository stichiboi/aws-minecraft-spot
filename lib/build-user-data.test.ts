import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { buildUserDataBundle } from "./build-user-data";

const LIB_DIR = __dirname;

describe("buildUserDataBundle", () => {
  it("embeds per-boot.sh as base64 and decoding round-trips correctly", () => {
    const { userDataScript } = buildUserDataBundle({ templatesDir: LIB_DIR });
    const perBootRaw = fs.readFileSync(
      path.join(LIB_DIR, "per-boot.sh"),
      "utf-8"
    );

    const m = userDataScript.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d >/);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], "base64").toString("utf-8")).toBe(perBootRaw);
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

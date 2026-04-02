import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  buildUserDataBundle,
  EXAMPLE_USER_DATA_PLACEHOLDERS,
  USER_DATA_OUTER_FN_SUB_KEYS,
  USER_DATA_PLACEHOLDER_KEYS,
} from "./build-user-data";
import { interpolateUserDataScript, stripCfnSubEscapes } from "./interpolate-user-data";
import { findFnSubTemplateIssues } from "./validate-fn-sub-template";

const LIB_DIR = __dirname;

const PER_BOOT_FN_SUB_KEYS = new Set<string>(USER_DATA_PLACEHOLDER_KEYS);
const USER_DATA_FN_SUB_KEYS = new Set<string>(USER_DATA_OUTER_FN_SUB_KEYS);

describe("buildUserDataBundle", () => {
  it("produces user-data with no unresolved ${BUCKET_NAME}-style placeholders", () => {
    const bundle = buildUserDataBundle({
      templatesDir: LIB_DIR,
      placeholders: EXAMPLE_USER_DATA_PLACEHOLDERS,
    });

    expect(bundle.userDataScript).not.toContain("${PER_BOOT_SCRIPT_B64}");
    expect(bundle.userDataScript).not.toMatch(
      /\$\{(BUCKET_NAME|HOSTED_ZONE_ID|FQDN|MINECRAFT_PORT|VOLUME_ID)\}/
    );
    expect(bundle.perBootScript).toContain(
      `BUCKET_NAME="${EXAMPLE_USER_DATA_PLACEHOLDERS.BUCKET_NAME}"`
    );
    expect(bundle.perBootScript).not.toContain("${!");
    expect(bundle.userDataScript).not.toContain("${!");
  });

  it("inlines base64 per-boot so decoding matches perBootScript", () => {
    const bundle = buildUserDataBundle({
      templatesDir: LIB_DIR,
      placeholders: EXAMPLE_USER_DATA_PLACEHOLDERS,
    });

    const m = bundle.userDataScript.match(
      /echo "([A-Za-z0-9+/=]+)" \| base64 -d >/
    );
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1], "base64").toString("utf-8");
    expect(decoded).toBe(bundle.perBootScript);
  });

  it("matches interpolate + strip of checked-in template (stable templates)", () => {
    const perBootRaw = fs.readFileSync(path.join(LIB_DIR, "per-boot.sh"), "utf-8");
    const bundle = buildUserDataBundle({
      templatesDir: LIB_DIR,
      placeholders: EXAMPLE_USER_DATA_PLACEHOLDERS,
    });
    const expectedPerBoot = stripCfnSubEscapes(
      interpolateUserDataScript(perBootRaw, EXAMPLE_USER_DATA_PLACEHOLDERS)
    );

    expect(bundle.perBootScript).toBe(expectedPerBoot);
  });
});

describe("Fn::Sub shell template safety (raw files as in CDK Fn.sub)", () => {
  it("per-boot.sh has only valid ${…} for CloudFormation + known keys", () => {
    const raw = fs.readFileSync(path.join(LIB_DIR, "per-boot.sh"), "utf-8");
    const issues = findFnSubTemplateIssues(raw, PER_BOOT_FN_SUB_KEYS);
    expect(issues, issues.join("\n")).toEqual([]);
  });

  it("user-data.sh has only valid ${…} for CloudFormation + known keys", () => {
    const raw = fs.readFileSync(path.join(LIB_DIR, "user-data.sh"), "utf-8");
    const issues = findFnSubTemplateIssues(raw, USER_DATA_FN_SUB_KEYS);
    expect(issues, issues.join("\n")).toEqual([]);
  });

  it("rejects bash parameter expansion in a comment (regression: deploy ValidationError)", () => {
    const bad = "# tip: use ${VOLUME_ID//-/} — breaks Fn::Sub\nVOLUME_ID=\"${VOLUME_ID}\"\n";
    const issues = findFnSubTemplateIssues(bad, PER_BOOT_FN_SUB_KEYS);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((e) => e.includes("VOLUME_ID//-/"))).toBe(true);
  });

  it("rejects unknown placeholders not in the per-boot Fn::Sub map", () => {
    const bad = '# doc (${KEY})\nVOLUME_ID="${VOLUME_ID}"\n';
    const issues = findFnSubTemplateIssues(bad, PER_BOOT_FN_SUB_KEYS);
    expect(issues.some((e) => e.includes("KEY"))).toBe(true);
  });

  it("rejects invalid ${!…} literal bodies", () => {
    const bad = 'echo "${!bad-name}"\nVOLUME_ID="${VOLUME_ID}"\n';
    const issues = findFnSubTemplateIssues(bad, PER_BOOT_FN_SUB_KEYS);
    expect(issues.some((e) => e.includes("bad-name"))).toBe(true);
  });
});

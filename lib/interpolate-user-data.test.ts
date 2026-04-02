import { describe, expect, it } from "vitest";
import { App, Size, Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { interpolateUserDataScript } from "./interpolate-user-data";

const plainPlaceholders: Record<string, string> = {
  BUCKET_NAME: "my-mods-bucket",
  HOSTED_ZONE_ID: "Z1234567890ABC",
  FQDN: "mc.example.com",
  MINECRAFT_PORT: "25565",
  VOLUME_ID: "vol-0feedface",
};

describe("interpolateUserDataScript", () => {
  it("replaces every configured placeholder", () => {
    const script = [
      'BUCKET="${BUCKET_NAME}"',
      'ZONE="${HOSTED_ZONE_ID}"',
      'FQDN="${FQDN}"',
      'PORT="${MINECRAFT_PORT}"',
      'VOL="${VOLUME_ID}"',
    ].join("\n");

    const out = interpolateUserDataScript(script, plainPlaceholders);

    expect(out).toContain('BUCKET="my-mods-bucket"');
    expect(out).toContain('ZONE="Z1234567890ABC"');
    expect(out).toContain('FQDN="mc.example.com"');
    expect(out).toContain('PORT="25565"');
    expect(out).toContain('VOL="vol-0feedface"');
  });

  it("replaces multiple occurrences of the same key", () => {
    const out = interpolateUserDataScript(
      "${VOLUME_ID} and again ${VOLUME_ID}",
      plainPlaceholders
    );
    expect(out).toBe("vol-0feedface and again vol-0feedface");
  });

  it("escapes regex metacharacters in placeholder keys (defensive)", () => {
    const out = interpolateUserDataScript("x=${A.B}", { "A.B": "ok" });
    expect(out).toBe("x=ok");
  });

  /**
   * CDK attributes like `volumeId` are typed as `string` but are unresolved
   * tokens at synthesis time. `String.prototype.replace` stringifies them to
   * `${Token[TOKEN.n]}`-style markers. Bash then treats `${Token[TOKEN.n]}`
   * like an array index and runs the bracket content as arithmetic — hence
   * errors such as: invalid arithmetic operator (error token is ".43").
   */
  it("embeds CDK Token markers when a construct attribute is passed as value", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    const vpc = new ec2.Vpc(stack, "Vpc", { maxAzs: 1, natGateways: 0 });
    const volume = new ec2.Volume(stack, "DataVolume", {
      availabilityZone: vpc.publicSubnets[0].availabilityZone,
      size: Size.gibibytes(8),
    });

    const out = interpolateUserDataScript('ID="${VOLUME_ID}"', {
      ...plainPlaceholders,
      VOLUME_ID: volume.volumeId,
    });

    expect(out).toMatch(/\$\{Token\[/);
    expect(out).not.toMatch(/^ID="vol-[0-9a-f]+"$/);
  });
});

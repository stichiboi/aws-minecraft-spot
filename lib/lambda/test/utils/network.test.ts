import { describe, expect, it } from "vitest";
import { probePort } from "../../utils/network";

describe("utils/network", () => {
  describe("probePort", () => {
    it("returns false for an unreachable host", async () => {
      await expect(probePort("127.0.0.1", 1, 200)).resolves.toBe(false);
    });
  });
});

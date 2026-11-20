import { afterEach, describe, expect, it, vi } from "vitest";
import { open, seal } from "./secret-box";

afterEach(() => vi.unstubAllEnvs());

describe("this service's secret box", () => {
  it("still opens a value sealed before the move to integration_common (same dev seed)", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    // Sealed on 2026-11-03 by the old src/crypto/secret-box.ts with the development key.
    const before = "v1.ZyRqzJ5GpDiXZdFz.IAzKDpXAmz1epTTpamKJSA.rOOOIzc3cv_LdPChRwXvlc_mGD3f";
    expect(open(before)).toBe("orbitops-compat-check");
  });

  it("round-trips", () => {
    expect(open(seal("rnd_key"))).toBe("rnd_key");
  });
});

import { describe, expect, it, vi } from "vitest";
import { envHash, keysToDelete } from "./env-hash";
import { EnvVault } from "./env-vault";

describe("EnvVault", () => {
  it("hands the vars over once, then forgets them", () => {
    const vault = new EnvVault();
    vault.put("d1", [{ key: "A", value: "1" }]);
    vault.put("d2", undefined);
    expect(vault.take("d1")).toEqual([{ key: "A", value: "1" }]);
    expect(vault.take("d1")).toBeUndefined();
    expect(vault.take("d2")).toEqual([]);
  });

  it("drops entries after the TTL", () => {
    vi.useFakeTimers();
    try {
      const vault = new EnvVault(1000);
      vault.put("d1", [{ key: "A", value: "1" }]);
      vi.advanceTimersByTime(1001);
      expect(vault.take("d1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("envHash", () => {
  it("ignores order, changes with any key, value or secret flag", () => {
    const base = envHash([{ key: "A", value: "1" }, { key: "B", value: "2" }]);
    expect(envHash([{ key: "B", value: "2" }, { key: "A", value: "1" }])).toBe(base);
    expect(envHash([{ key: "A", value: "1" }, { key: "B", value: "3" }])).not.toBe(base);
    const config = envHash([{ key: "A", value: "1", secret: false }]);
    expect(envHash([{ key: "A", value: "1", secret: true }])).not.toBe(config);
    expect(envHash([{ key: "A", value: "1" }])).not.toBe(config);
  });

  it("keeps the Phase 7 hash for vars without a secret flag", () => {
    // sha256("A\0" + "1\0"), what render_integration stored before Phase 9.
    expect(envHash([{ key: "A", value: "1" }])).toBe("e722cfcc65cc7c01d3816a7d3abafc9e116230d3ee3fcd5ab925f38814f113c2");
  });
});

describe("keysToDelete", () => {
  it("returns managed keys no longer wanted, from plain or {key} lists", () => {
    expect(keysToDelete(["A", "B"], [{ key: "A" }])).toEqual(["B"]);
    expect(keysToDelete([{ key: "A", secret: true }, { key: "C" }], [])).toEqual(["A", "C"]);
    expect(keysToDelete("junk", [])).toEqual([]);
  });
});

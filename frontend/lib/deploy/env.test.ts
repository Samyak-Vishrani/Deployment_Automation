import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDotenv } from "./env-file";
import { looksSecret, rowProblem } from "./env-rules";

/** Everything after the header comment, which differs between the two copies on purpose. */
const body = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/^\/\*\*[\s\S]*?\*\/\n/, "");

describe("env-file", () => {
  it("is the same parser as the backend's copy", () => {
    expect(body(resolve(__dirname, "env-file.ts"))).toBe(body(resolve(__dirname, "../../../backend/lib/env/env-file.ts")));
  });

  it("parses quoted, exported and commented lines", () => {
    const { entries, skipped } = parseDotenv('export A=1 # c\nB="x\\ny"\nnope\n');
    expect(entries).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "x\ny" },
    ]);
    expect(skipped).toEqual([{ line: 3, reason: "no KEY=value" }]);
  });
});

describe("env-rules", () => {
  it("mirrors the backend's checks", () => {
    expect(looksSecret("STRIPE_SECRET_KEY")).toBe(true);
    expect(looksSecret("NEXT_PUBLIC_STRIPE_KEY")).toBe(false);
    expect(rowProblem("NEXT_PUBLIC_X", true, { kind: "frontend", provider: "vercel" })).toMatch(/browser code/);
    expect(rowProblem("NEXT_PUBLIC_X", true, { kind: "backend", provider: "render" })).toBeNull();
    expect(rowProblem("VERCEL_URL", false, { kind: "frontend", provider: "vercel" })).toMatch(/reserved by Vercel/);
    expect(rowProblem("RENDER_X", false, { kind: "shared" })).toMatch(/Render/);
    expect(rowProblem("9X", false, { kind: "shared" })).toMatch(/Letters/);
  });
});

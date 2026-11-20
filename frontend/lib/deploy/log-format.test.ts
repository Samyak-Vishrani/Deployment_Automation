import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { entryToText, isErrorLine } from "./log-format";

/** From `const ERROR_WORDS` to the end: the part that must stay identical to the logs service's. */
const rule = (path: string) => {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  return text.slice(text.indexOf("const ERROR_WORDS")).trim();
};

describe("log-format", () => {
  it("uses the same error rule as backend/logs", () => {
    expect(rule(resolve(__dirname, "log-format.ts"))).toBe(rule(resolve(__dirname, "../../../backend/logs/src/entries/errors.ts")));
  });

  it("flags errors the way the logs service does", () => {
    expect(isErrorLine({ stream: "stderr", source: "render", text: "warn" })).toBe(true);
    expect(isErrorLine({ stream: "stderr", source: "docker", text: "#5 RUN npm ci" })).toBe(false);
    expect(isErrorLine({ stream: "stdout", text: "npm ERR! missing script" })).toBe(true);
    expect(isErrorLine({ stream: "stdout", text: "all good" })).toBe(false);
  });

  it("renders a copyable line with its source", () => {
    expect(entryToText({ at: 0, source: "vercel", text: "hi" })).toBe("[--:--:--] [vercel] hi");
  });
});

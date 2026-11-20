import { describe, expect, it } from "vitest";
import { entryToText, tailText } from "./entry-text";
import { isErrorLine } from "./errors";
import { parseLegacyLine } from "./legacy";

const entry = (over: object = {}) => ({ seq: 1, at: Date.UTC(2026, 10, 4, 12, 3, 4), source: "render" as const, phase: "build" as const, stream: "stdout" as const, text: "hello", ...over });

describe("entryToText and tailText", () => {
  it("renders time, source and text", () => {
    expect(entryToText(entry())).toBe("[12:03:04] [render] hello");
    expect(entryToText(entry({ at: 0 }))).toBe("[--:--:--] [render] hello");
  });

  it("keeps whole lines within the byte budget", () => {
    const entries = [entry({ text: "a".repeat(30) }), entry({ text: "b" }), entry({ text: "c" })];
    expect(tailText(entries, 60).split("\n").filter(Boolean)).toEqual(["[12:03:04] [render] b", "[12:03:04] [render] c"]);
  });
});

describe("parseLegacyLine", () => {
  it("reads the old [hh:mm:ss] prefix on the file's day, as an orbitops line", () => {
    const day = new Date(Date.UTC(2026, 10, 3));
    expect(parseLegacyLine("[10:00:01] ==> Deploying shop", 4, day)).toEqual({
      seq: 4,
      at: Date.UTC(2026, 10, 3, 10, 0, 1),
      source: "orbitops",
      phase: "build",
      stream: "info",
      text: "==> Deploying shop",
    });
    expect(parseLegacyLine("no prefix", 5, day)).toMatchObject({ at: 0, text: "no prefix" });
  });
});

describe("isErrorLine", () => {
  it("flags stderr, error levels and error words, but not docker's stderr progress", () => {
    expect(isErrorLine({ stream: "stderr", text: "warn" })).toBe(true);
    expect(isErrorLine({ stream: "stderr", source: "docker", text: "#5 [2/4] RUN npm ci" })).toBe(false);
    expect(isErrorLine({ stream: "stdout", text: "npm ERR! code ELIFECYCLE" })).toBe(true);
    expect(isErrorLine({ stream: "stdout", level: "fatal", text: "x" })).toBe(true);
    expect(isErrorLine({ stream: "stdout", text: "Build failed" })).toBe(true);
    expect(isErrorLine({ stream: "stdout", text: "errorless terror" })).toBe(false);
  });
});

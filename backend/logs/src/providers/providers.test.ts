import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toRenderRuntimeLines } from "./render-runtime";
import { toVercelRuntimeLine } from "./vercel-runtime";

const fixture = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

describe("toVercelRuntimeLine", () => {
  it("maps rows (numbers as strings too), keeps the request, flags errors and drops delimiters", () => {
    const lines = fixture("vercel-runtime.ndjson")
      .split("\n")
      .filter(Boolean)
      .map((l) => toVercelRuntimeLine(JSON.parse(l)));
    expect(lines[0]).toEqual({
      id: "r1",
      at: 1762250000000,
      stream: "stdout",
      level: "info",
      text: "GET /api/hello",
      request: { method: "GET", path: "/api/hello", status: 200 },
    });
    expect(lines[1]).toMatchObject({ text: "hello from the function", stream: "stdout" });
    expect(lines[2]).toMatchObject({
      stream: "stderr",
      level: "error",
      text: "TypeError: cannot read properties of undefined …(truncated by Vercel)",
      request: { status: 500 },
    });
    expect(lines[3]).toBeNull();
    expect(toVercelRuntimeLine("nope")).toBeNull();
  });

  it("uses the request as text for a request row without a message", () => {
    expect(toVercelRuntimeLine({ rowId: "x", timestampInMs: 1, requestMethod: "POST", requestPath: "/a", responseStatusCode: 201, source: "request" }))
      .toMatchObject({ text: "POST /a 201" });
  });
});

describe("toRenderRuntimeLines", () => {
  const page = JSON.parse(fixture("render-runtime-page.json"));

  it("keeps app lines, drops build output and blanks, and hides requests unless asked", () => {
    const lines = toRenderRuntimeLines(page, { includeRequests: false });
    expect(lines.map((l) => l.id)).toEqual(["l2", "l4"]);
    expect(lines[0]).toEqual({ id: "l2", at: Date.parse("2026-11-04T10:00:01Z"), stream: "stdout", level: "info", text: "Server listening on 10000" });
    expect(lines[1]).toMatchObject({ stream: "stderr", level: "error" });
  });

  it("includes request lines with method, path and status when asked", () => {
    const lines = toRenderRuntimeLines(page, { includeRequests: true });
    expect(lines.find((l) => l.id === "l3")).toMatchObject({ text: "GET /db 200 12ms", request: { method: "GET", path: "/db", status: 200 } });
    expect(toRenderRuntimeLines({ logs: "x" }, { includeRequests: true })).toEqual([]);
  });
});

describe("ANSI codes", () => {
  it("are stripped from runtime lines, as Render sends them", () => {
    const esc = String.fromCharCode(27);
    const message = `${esc}[32m${esc}[1m==>${esc}(B${esc}[m ${esc}[1mRunning 'npm start'${esc}(B${esc}[m`;
    const [line] = toRenderRuntimeLines(
      { logs: [{ id: "x", message, timestamp: "2026-11-03T07:08:21Z", labels: [{ name: "type", value: "app" }] }] },
      { includeRequests: false },
    );
    expect(line.text).toBe("==> Running 'npm start'");
  });
});

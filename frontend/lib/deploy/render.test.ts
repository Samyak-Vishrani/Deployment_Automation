import { describe, expect, it } from "vitest";
import { parseEnvText, isActiveRender } from "./render";
describe("Render configuration", () => {
  it("preserves equals signs inside credentials and skips comments", () => {
    expect(parseEnvText("# comment\nTOKEN=abc==\nDATABASE_URL=postgres://a:b@host/db?x=y\n")).toEqual({ TOKEN: "abc==", DATABASE_URL: "postgres://a:b@host/db?x=y" });
  });
  it.each(["TOKEN", "X=a\nX=b", "__proto__=x", "BAD-KEY=a"])("rejects invalid input %s", input => expect(() => parseEnvText(input)).toThrow());
  it("supports explicit clearing and blocks duplicate deploys in uncertain state", () => {
    expect(parseEnvText("")).toEqual({}); expect(isActiveRender("uncertain")).toBe(true); expect(isActiveRender("failed")).toBe(false);
  });
});

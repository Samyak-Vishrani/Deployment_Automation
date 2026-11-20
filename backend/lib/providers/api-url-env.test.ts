import { describe, expect, it } from "vitest";
import { apiUrlKey } from "./api-url-env";
import { parseNeonPrefsBody, parseProviderParam } from "./credential-input";

describe("apiUrlKey", () => {
  it.each([
    ["nextjs", null, "NEXT_PUBLIC_API_URL"],
    ["nuxt", null, "NUXT_PUBLIC_API_URL"],
    ["astro", null, "PUBLIC_API_URL"],
    ["sveltekit", null, "PUBLIC_API_URL"],
    ["vite", null, "VITE_API_URL"],
    ["vue", null, "VITE_API_URL"],
    ["react", "vite build", "VITE_API_URL"],
    ["react", "react-scripts build", "REACT_APP_API_URL"],
    ["angular", null, "API_URL"],
    [null, null, "API_URL"],
  ])("%s (%s) → %s", (framework, buildCmd, key) => {
    expect(apiUrlKey(framework, buildCmd)).toBe(key);
  });
});

describe("Neon credential input", () => {
  it("accepts neon as a provider", () => {
    expect(parseProviderParam("neon")).toBe("neon");
    expect(() => parseProviderParam("local_docker")).toThrow(/Unknown provider/);
  });

  it("validates the preferences body", () => {
    expect(parseNeonPrefsBody({ orgId: null, regionId: "aws-us-west-2", pgVersion: 17 })).toEqual({
      orgId: null,
      regionId: "aws-us-west-2",
      pgVersion: 17,
    });
    expect(() => parseNeonPrefsBody({ pgVersion: "17" })).toThrow(/pgVersion/);
    expect(() => parseNeonPrefsBody({ plan: "free" })).toThrow();
    expect(() => parseNeonPrefsBody({})).toThrow(/at least one/);
  });
});

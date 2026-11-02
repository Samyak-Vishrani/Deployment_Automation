import { describe, expect, it } from "vitest";
import { parseComponentSet, parseUpdateComponent } from "@/lib/components/component-input";

const frontend = { kind: "frontend", name: "web", rootDir: "frontend", buildCmd: "npm run build" };

function errorOf(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (error) {
    return error as { status: number; message: string };
  }
  throw new Error("expected a throw");
}

describe("parseComponentSet", () => {
  it("defaults the provider from the kind and normalises the folder", () => {
    const [parsed] = parseComponentSet({ components: [{ ...frontend, rootDir: "./frontend/" }] });
    expect(parsed).toMatchObject({ kind: "frontend", provider: "vercel", rootDir: "frontend" });
    expect(parsed.startCmd).toBeNull();
  });

  it("treats an empty folder as the repository root", () => {
    const [parsed] = parseComponentSet({ components: [{ ...frontend, rootDir: "" }] });
    expect(parsed.rootDir).toBe(".");
  });

  it("rejects a provider the MVP does not allow for the kind", () => {
    const error = errorOf(() =>
      parseComponentSet({ components: [{ ...frontend, provider: "render" }] }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain("deploys to Vercel");
  });

  it.each(["../x", "frontend/../../etc", "/abs", "C:/x", "a\\b"])("rejects the folder %s", (rootDir) => {
    const error = errorOf(() => parseComponentSet({ components: [{ ...frontend, rootDir }] }));
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/relative|\.\./);
  });

  it("rejects unknown keys, naming the component", () => {
    const error = errorOf(() =>
      parseComponentSet({ components: [{ ...frontend, providerResourceId: "prj_1" }] }),
    );
    expect(error.message).toBe("components[0]: Unexpected field(s): providerResourceId.");
  });

  it("rejects unknown keys at the top level", () => {
    expect(errorOf(() => parseComponentSet({ components: [], extra: 1 })).status).toBe(400);
  });

  it("rejects a multi-line command", () => {
    const error = errorOf(() =>
      parseComponentSet({ components: [{ ...frontend, buildCmd: "npm ci\nrm -rf /" }] }),
    );
    expect(error.message).toContain("single line");
  });

  it("rejects a command over 500 characters", () => {
    const error = errorOf(() =>
      parseComponentSet({ components: [{ ...frontend, buildCmd: "x".repeat(501) }] }),
    );
    expect(error.message).toContain("at most 500");
  });

  it("allows at most one database", () => {
    const db = { kind: "database", name: "db" };
    const error = errorOf(() =>
      parseComponentSet({ components: [db, { ...db, rootDir: "other" }] }),
    );
    expect(error.message).toContain("at most one database");
  });

  it("rejects commands on a database", () => {
    const error = errorOf(() =>
      parseComponentSet({ components: [{ kind: "database", name: "db", startCmd: "postgres" }] }),
    );
    expect(error.message).toContain("no startCmd");
  });

  it("rejects two components of one kind in one folder", () => {
    const error = errorOf(() =>
      parseComponentSet({ components: [frontend, { ...frontend, name: "other" }] }),
    );
    expect(error.message).toContain('use the folder "frontend"');
  });

  it("requires a name", () => {
    expect(errorOf(() => parseComponentSet({ components: [{ kind: "backend" }] })).message).toContain(
      "name is required",
    );
  });
});

describe("parseUpdateComponent", () => {
  it("keeps only the fields that were sent, and clears the ones sent empty", () => {
    expect(parseUpdateComponent({ buildCmd: "", rootDir: "api/" })).toEqual({
      buildCmd: null,
      rootDir: "api",
    });
  });

  it("does not allow changing the kind", () => {
    expect(errorOf(() => parseUpdateComponent({ kind: "backend" })).message).toContain("kind");
  });
});

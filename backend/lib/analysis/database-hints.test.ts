import { describe, it, expect } from "vitest";
import { detectDatabaseUsage, type DatabaseHintInput } from "@/lib/analysis/database-hints";

const input = (partial: Partial<DatabaseHintInput>): DatabaseHintInput => ({
  nodePackages: [],
  pythonPackages: [],
  prismaSchemas: [],
  envExamples: [],
  ...partial,
});

const node = (...dependencies: string[]) => [{ path: "package.json", dependencies }];
const python = (...dependencies: string[]) => [{ path: "requirements.txt", dependencies }];
const prisma = (provider: string) => [
  {
    path: "prisma/schema.prisma",
    content: `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "${provider}"\n  url = env("DATABASE_URL")\n}\n`,
  },
];

describe("detectDatabaseUsage", () => {
  it("reports nothing when there is no evidence", () => {
    expect(detectDatabaseUsage(input({ nodePackages: node("next", "react") }))).toEqual({
      detected: false,
      engine: "unknown",
      evidence: [],
      suggestNeon: false,
    });
  });

  it("Prisma on PostgreSQL suggests Neon", () => {
    const hint = detectDatabaseUsage(
      input({ nodePackages: node("@prisma/client"), prismaSchemas: prisma("postgresql") }),
    );

    expect(hint).toMatchObject({ detected: true, engine: "postgres", suggestNeon: true });
    expect(hint.evidence).toEqual(["prisma/schema.prisma: provider", "package.json: @prisma/client"]);
  });

  it("reads the datasource provider, not the generator's", () => {
    expect(detectDatabaseUsage(input({ prismaSchemas: prisma("mysql") })).engine).toBe("mysql");
  });

  it("Mongoose never suggests Neon", () => {
    expect(detectDatabaseUsage(input({ nodePackages: node("express", "mongoose") }))).toMatchObject({
      detected: true,
      engine: "mongodb",
      suggestNeon: false,
    });
  });

  it("an ORM alongside MongoDB is still MongoDB", () => {
    expect(
      detectDatabaseUsage(input({ nodePackages: node("typeorm", "mongodb") })),
    ).toMatchObject({ engine: "mongodb", suggestNeon: false });
  });

  it.each([
    ["pg", "postgres", true],
    ["postgres", "postgres", true],
    ["mysql2", "mysql", false],
    ["better-sqlite3", "sqlite", false],
  ])("the %s driver means %s", (driver, engine, suggestNeon) => {
    expect(detectDatabaseUsage(input({ nodePackages: node(driver) }))).toMatchObject({
      engine,
      suggestNeon,
    });
  });

  it.each(["typeorm", "sequelize", "drizzle-orm", "knex", "prisma"])(
    "%s alone is SQL of an unknown engine, which suggests Neon",
    (orm) => {
      expect(detectDatabaseUsage(input({ nodePackages: node(orm) }))).toMatchObject({
        detected: true,
        engine: "unknown",
        suggestNeon: true,
      });
    },
  );

  it("names the engine when an ORM comes with a driver", () => {
    expect(detectDatabaseUsage(input({ nodePackages: node("typeorm", "pg") })).engine).toBe("postgres");
  });

  it("prefers Postgres when a repo uses both Postgres and MongoDB", () => {
    expect(
      detectDatabaseUsage(input({ nodePackages: node("mongoose", "pg") })),
    ).toMatchObject({ engine: "postgres", suggestNeon: true });
  });

  it("an explicit Prisma provider beats an inferred driver", () => {
    const hint = detectDatabaseUsage(
      input({ nodePackages: node("pg"), prismaSchemas: prisma("mysql") }),
    );

    expect(hint).toMatchObject({ engine: "mysql", suggestNeon: false });
  });

  it("Python drivers and ORMs", () => {
    expect(detectDatabaseUsage(input({ pythonPackages: python("fastapi", "asyncpg") })).engine).toBe(
      "postgres",
    );
    expect(
      detectDatabaseUsage(input({ pythonPackages: python("flask", "sqlalchemy") })),
    ).toMatchObject({ engine: "unknown", suggestNeon: true });
    expect(
      detectDatabaseUsage(input({ pythonPackages: python("django", "psycopg2-binary") })).engine,
    ).toBe("postgres");
  });

  it("Django alone uses its ORM, so a database is suggested", () => {
    expect(detectDatabaseUsage(input({ pythonPackages: python("django") }))).toMatchObject({
      detected: true,
      engine: "unknown",
      suggestNeon: true,
    });
  });

  it("finds DATABASE_URL in .env.example and reads the scheme", () => {
    const env = (content: string) => input({ envExamples: [{ path: ".env.example", content }] });

    expect(detectDatabaseUsage(env("PORT=3000\nDATABASE_URL=\n"))).toMatchObject({
      detected: true,
      engine: "unknown",
      suggestNeon: true,
    });
    expect(
      detectDatabaseUsage(env('DATABASE_URL="postgresql://user:pass@localhost:5432/app"\n')).engine,
    ).toBe("postgres");
    expect(detectDatabaseUsage(env("DATABASE_URL=mongodb+srv://cluster/app\n")).suggestNeon).toBe(false);
    expect(detectDatabaseUsage(env("# DATABASE_URL is set by the platform\nPORT=3000\n")).detected).toBe(
      false,
    );
  });

  it("never copies a connection string into the evidence", () => {
    const hint = detectDatabaseUsage(
      input({
        envExamples: [
          { path: ".env.example", content: "DATABASE_URL=postgres://admin:hunter2@db.internal/app\n" },
        ],
      }),
    );

    expect(hint.evidence).toEqual([".env.example: DATABASE_URL"]);
    expect(JSON.stringify(hint)).not.toContain("hunter2");
  });
});

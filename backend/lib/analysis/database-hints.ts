/**
 * Detects database usage from files the analysis has already read, and decides
 * whether to suggest provisioning a Neon (Postgres) database.
 *
 * Pure: it is handed dependency names and file contents, and reads nothing.
 */

export type DatabaseEngine = "postgres" | "mysql" | "mongodb" | "sqlite" | "unknown";

export type DatabaseHint = {
  detected: boolean;
  engine: DatabaseEngine;
  /** Human-readable reasons, e.g. "backend/package.json: pg". Never a value. */
  evidence: string[];
  /** True for Postgres and for SQL of an unknown engine; never for MongoDB. */
  suggestNeon: boolean;
};

export type DatabaseHintInput = {
  /** Dependency names per package.json. */
  nodePackages: { path: string; dependencies: string[] }[];
  /** Normalised package names per Python manifest. */
  pythonPackages: { path: string; dependencies: string[] }[];
  prismaSchemas: { path: string; content: string }[];
  envExamples: { path: string; content: string }[];
};

/** Drivers name their engine outright. */
const NODE_DRIVERS: Record<string, DatabaseEngine> = {
  pg: "postgres",
  postgres: "postgres",
  "@neondatabase/serverless": "postgres",
  mysql2: "mysql",
  mysql: "mysql",
  mongoose: "mongodb",
  mongodb: "mongodb",
  sqlite3: "sqlite",
  "better-sqlite3": "sqlite",
};

/** ORMs and query builders prove a SQL database is in use, but not which. */
const NODE_ORMS = ["@prisma/client", "prisma", "typeorm", "sequelize", "drizzle-orm", "knex"];

const PYTHON_DRIVERS: Record<string, DatabaseEngine> = {
  psycopg: "postgres",
  psycopg2: "postgres",
  "psycopg2-binary": "postgres",
  asyncpg: "postgres",
  pymysql: "mysql",
  mysqlclient: "mysql",
  pymongo: "mongodb",
  motor: "mongodb",
};

/** Django ships with an ORM; its settings default to SQLite until changed. */
const PYTHON_ORMS = ["sqlalchemy", "django"];

const PRISMA_PROVIDERS: Record<string, DatabaseEngine> = {
  postgresql: "postgres",
  postgres: "postgres",
  cockroachdb: "postgres",
  mysql: "mysql",
  mongodb: "mongodb",
  sqlite: "sqlite",
};

const URL_SCHEMES: [RegExp, DatabaseEngine][] = [
  [/^postgres(ql)?:/i, "postgres"],
  [/^mysql:/i, "mysql"],
  [/^mongodb(\+srv)?:/i, "mongodb"],
  [/^(file|sqlite):/i, "sqlite"],
];

/** Strongest signal first: an explicit declaration beats an inferred driver. */
const RANK = { declared: 3, driver: 2, orm: 1 } as const;

/** A repo using both Postgres and MongoDB still needs the Postgres provisioned. */
const TIE_ORDER: DatabaseEngine[] = ["postgres", "mysql", "sqlite", "mongodb", "unknown"];

type Signal = { engine: DatabaseEngine; rank: number };

function prismaProvider(content: string): DatabaseEngine | null {
  const datasource = content.match(/datasource\s+\w+\s*\{([\s\S]*?)\}/);
  const provider = datasource?.[1].match(/^\s*provider\s*=\s*"([^"]+)"/m)?.[1];
  if (!provider) return null;
  const key = provider.toLowerCase();
  return Object.hasOwn(PRISMA_PROVIDERS, key) ? PRISMA_PROVIDERS[key] : "unknown";
}

/** The DATABASE_URL entry of a dotenv file: present at all, and its engine if the value says. */
function databaseUrl(content: string): { engine: DatabaseEngine } | null {
  const match = content.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/m);
  if (!match) return null;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  for (const [scheme, engine] of URL_SCHEMES) {
    if (scheme.test(value)) return { engine };
  }
  return { engine: "unknown" };
}

export function detectDatabaseUsage(input: DatabaseHintInput): DatabaseHint {
  const evidence: string[] = [];
  const signals: Signal[] = [];

  for (const schema of input.prismaSchemas) {
    const engine = prismaProvider(schema.content);
    if (engine) {
      evidence.push(`${schema.path}: provider`);
      signals.push({ engine, rank: RANK.declared });
    }
  }

  for (const env of input.envExamples) {
    const url = databaseUrl(env.content);
    if (url) {
      // The key only. An example file can still hold a real connection string.
      evidence.push(`${env.path}: DATABASE_URL`);
      signals.push({
        engine: url.engine,
        rank: url.engine === "unknown" ? RANK.orm : RANK.declared,
      });
    }
  }

  const scan = (
    packages: DatabaseHintInput["nodePackages"],
    drivers: Record<string, DatabaseEngine>,
    orms: string[],
  ) => {
    for (const pkg of packages) {
      for (const dependency of pkg.dependencies) {
        if (Object.hasOwn(drivers, dependency)) {
          evidence.push(`${pkg.path}: ${dependency}`);
          signals.push({ engine: drivers[dependency], rank: RANK.driver });
        } else if (orms.includes(dependency)) {
          evidence.push(`${pkg.path}: ${dependency}`);
          signals.push({ engine: "unknown", rank: RANK.orm });
        }
      }
    }
  };
  scan(input.nodePackages, NODE_DRIVERS, NODE_ORMS);
  scan(input.pythonPackages, PYTHON_DRIVERS, PYTHON_ORMS);

  if (signals.length === 0) {
    return { detected: false, engine: "unknown", evidence: [], suggestNeon: false };
  }

  // A named engine beats "unknown" at any rank: an ORM plus a pg driver is
  // Postgres. Among named engines the highest rank wins, and a tie is settled
  // by TIE_ORDER rather than by the order dependencies happen to be listed in.
  const named = signals.filter((signal) => signal.engine !== "unknown");
  const pool = named.length > 0 ? named : signals;
  const topRank = Math.max(...pool.map((signal) => signal.rank));
  const candidates = new Set(
    pool.filter((signal) => signal.rank === topRank).map((signal) => signal.engine),
  );
  const engine = TIE_ORDER.find((candidate) => candidates.has(candidate)) ?? "unknown";

  return {
    detected: true,
    engine,
    evidence: [...new Set(evidence)],
    suggestNeon: engine === "postgres" || engine === "unknown",
  };
}

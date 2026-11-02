import type { Db } from "../db";

/**
 * A tiny in-memory stand-in for the Prisma client, covering only the calls the
 * services make. Enough to test behaviour (what gets stored, what is read
 * back) without a database.
 */

type Row = Record<string, unknown>;

let nextId = 0;
const id = () => `id${++nextId}`;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "NOT") return !matches(row, condition as Row);
    if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      const c = condition as { notIn?: unknown[]; in?: unknown[]; equals?: unknown };
      if (c.notIn) return !c.notIn.includes(row[key]);
      if (c.in) return c.in.includes(row[key]);
      if ("equals" in c) return JSON.stringify(row[key]) === JSON.stringify(c.equals);
    }
    return row[key] === condition;
  });
}

function applyData(row: Row, data: Row): Row {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in (value as Row)) {
      row[key] = (row[key] as number) + ((value as { increment: number }).increment);
    } else {
      row[key] = structuredClone(value);
    }
  }
  row.updatedAt = new Date();
  return row;
}

function table(defaults: (data: Row) => Row) {
  const rows: Row[] = [];
  const find = (where: Row) => rows.find((r) => matches(r, where));
  return {
    rows,
    async findUnique({ where }: { where: Row }) {
      const row = find(where);
      return row ? structuredClone(row) : null;
    },
    async findMany({ where }: { where?: Row } = {}) {
      return rows.filter((r) => matches(r, where)).map((r) => structuredClone(r));
    },
    async count({ where }: { where?: Row } = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async create({ data }: { data: Row }) {
      const row = { ...defaults(data), ...structuredClone(data) };
      rows.push(row);
      return structuredClone(row);
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = find(where);
      if (!row) throw new Error("Record to update not found.");
      return structuredClone(applyData(row, data));
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const hits = rows.filter((r) => matches(r, where));
      hits.forEach((r) => applyData(r, data));
      return { count: hits.length };
    },
    async upsert({ where, create, update }: { where: Row; create: Row; update: Row }) {
      const row = find(where);
      if (row) return structuredClone(applyData(row, update));
      const created = { ...defaults(create), ...structuredClone(create) };
      rows.push(created);
      return structuredClone(created);
    },
    async delete({ where }: { where: Row }) {
      const index = rows.findIndex((r) => matches(r, where));
      if (index === -1) throw new Error("Record to delete not found.");
      return rows.splice(index, 1)[0];
    },
    async deleteMany({ where }: { where?: Row } = {}) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
      return { count: before - rows.length };
    },
  };
}

export function fakeDb() {
  const now = () => new Date();
  const db = {
    vercelCredential: table(() => ({ id: id(), teams: [], invalidAt: null, teamId: null, teamSlug: null, createdAt: now(), updatedAt: now() })),
    vercelProject: table(() => ({ id: id(), teamId: null, gitLinked: false, createdAt: now(), updatedAt: now() })),
    vercelDeployment: table(() => ({
      id: id(),
      state: "queued",
      vercelDeploymentId: null,
      sourceMode: null,
      url: null,
      inspectorUrl: null,
      productionUrl: null,
      errorMessage: null,
      lastEventAt: null,
      callbackSeq: 0,
      pendingEvents: [],
      createdAt: now(),
      updatedAt: now(),
      finishedAt: null,
    })),
  };
  return db as typeof db & Db;
}

export type FakeDb = ReturnType<typeof fakeDb>;

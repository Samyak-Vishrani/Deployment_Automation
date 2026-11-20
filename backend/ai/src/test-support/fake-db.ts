import type { Db } from "../db";

type Row = Record<string, unknown> & { id: string; createdAt: Date };

/** Just enough of Prisma's aiAnalysis delegate, in memory, for the service tests. */
export function fakeDb(now: () => Date = () => new Date()) {
  const rows: Row[] = [];
  let seq = 0;
  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, cond]) => {
      if (cond && typeof cond === "object" && !(cond instanceof Date) && "gte" in (cond as object)) {
        return (row[key] as Date) >= ((cond as { gte: Date }).gte);
      }
      return row[key] === cond;
    });
  const sorted = (list: Row[]) => [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const aiAnalysis = {
    rows,
    async create({ data }: { data: Record<string, unknown> }) {
      const row: Row = {
        id: `ai_${++seq}`,
        componentId: null,
        deploymentId: null,
        question: null,
        model: null,
        result: null,
        notice: null,
        promptTokens: null,
        completionTokens: null,
        durationMs: null,
        helpful: null,
        ...data,
        createdAt: now(),
      };
      rows.push(row);
      return structuredClone(row);
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      return sorted(rows).find((r) => matches(r, where)) ?? null;
    },
    async findUnique({ where }: { where: { id: string } }) {
      return rows.find((r) => r.id === where.id) ?? null;
    },
    async findMany({ where, take }: { where: Record<string, unknown>; take?: number }) {
      return sorted(rows.filter((r) => matches(r, where))).slice(0, take ?? rows.length);
    },
    async count({ where }: { where: Record<string, unknown> }) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  };
  return { db: { aiAnalysis } as unknown as Db, aiAnalysis };
}

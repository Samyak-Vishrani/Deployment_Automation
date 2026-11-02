/**
 * Isolated PostgreSQL checks; never defaults to the application's DATABASE_URL.
 * Set RENDER_TEST_DATABASE_URL to a database named orbitops_render_test.
 * Example: postgresql://postgres:test-only@localhost:55433/orbitops_render_test
 * Apply prisma migrate deploy with DATABASE_URL set to the same test URL first.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const url = process.env.RENDER_TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/orbitops_render_test") {
  throw new Error("Set RENDER_TEST_DATABASE_URL to the dedicated orbitops_render_test database. No application database will be used.");
}
const db = new PrismaClient({ datasources: { db: { url } } });
const tag = randomUUID();
let user;
let project;
let component;
try {
  user = await db.user.create({ data: { name: "Render DB test", email: `${tag}@example.invalid` } });
  project = await db.project.create({ data: { name: "Render DB test", userId: user.id } });
  component = await db.component.create({ data: { projectId: project.id, kind: "backend", provider: "render", name: "api" } });
  await db.renderConfig.create({ data: { componentId: component.id, ownerId: "test-owner", serviceName: `test-${tag}`, envEnc: "test-fixture-no-real-secret" } });

  const createIntent = key => db.renderDeployment.create({ data: { componentId: component.id, requestKey: key, secretSnapshotEnc: "test-fixture-no-real-secret" } });
  const attempts = await Promise.allSettled([createIntent(`${tag}-one`), createIntent(`${tag}-two`)]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1, "Only one concurrent active deployment can exist");
  const rejected = attempts.find(result => result.status === "rejected");
  assert.equal(rejected.reason.code, "P2002", "The database unique index rejects the duplicate");
  const first = attempts.find(result => result.status === "fulfilled").value;

  await db.renderDeployment.update({ where: { id: first.id }, data: { status: "failed" } });
  await assert.rejects(createIntent(first.requestKey), error => error.code === "P2002", "Request keys remain unique after completion");
  const second = await createIntent(`${tag}-three`);
  assert.ok(second.id, "A new attempt is possible after a terminal failure");

  const foreign = await db.renderDeployment.findFirst({ where: { id: second.id, config: { component: { project: { userId: "another-user" } } } } });
  assert.equal(foreign, null, "Nested ownership filters hide another user's deployment");
  await assert.rejects(db.project.delete({ where: { id: project.id } }), error => error.code === "P2003", "History prevents accidental cascade deletion");

  const now = new Date();
  const key = `${tag}:limit`;
  const counts = await Promise.all(Array.from({ length: 8 }, () => db.$queryRaw`
    INSERT INTO "RenderRateLimit" ("key", "window", "count") VALUES (${key}, ${now}, 1)
    ON CONFLICT ("key") DO UPDATE SET "count" = "RenderRateLimit"."count" + 1 RETURNING "count"`));
  assert.deepEqual(counts.map(rows => rows[0].count).sort((a, b) => a - b), [1,2,3,4,5,6,7,8], "Rate counts are atomic across concurrent requests");

  await db.$transaction(async tx => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`render:${user.id}`}))`; });
  console.log("PASS: Render migration, concurrent active uniqueness, durable idempotency, ownership filters, deletion protection, atomic rate counting, advisory locking.");
} finally {
  if (component) {
    await db.renderDeployment.deleteMany({ where: { componentId: component.id } });
    await db.renderConfig.deleteMany({ where: { componentId: component.id } });
    await db.component.deleteMany({ where: { id: component.id } });
  }
  if (project) await db.project.deleteMany({ where: { id: project.id } });
  if (user) await db.user.deleteMany({ where: { id: user.id } });
  await db.renderRateLimit.deleteMany({ where: { key: `${tag}:limit` } });
  await db.$disconnect();
}

/**
 * End-to-end exercise of the push decision pipeline, against a RUNNING backend.
 *
 * Unlike the vitest specs (which cover the pure predicates), this drives the
 * real HTTP route with real HMAC signatures and a real database, so it also
 * proves signature verification, delivery dedupe, the fan-out query and the
 * fire-and-forget handoff.
 *
 * Usage:  npm run dev   (in another terminal)
 *         npm run test:e2e
 */
const { createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PrismaClient } = require('@prisma/client');

/**
 * Minimal .env reader.
 *
 * Next.js loads .env itself, but this script is plain node, and pulling in
 * dotenv for four lines would add a dependency the app does not otherwise need.
 */
function loadEnv() {
  let text;
  try {
    text = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const URL = 'http://localhost:3001/api/webhooks/github';
const REPO_ID = 999000111;

if (!SECRET) {
  console.error('GITHUB_WEBHOOK_SECRET is not set. Fill in backend/.env first.');
  process.exit(1);
}

const prisma = new PrismaClient();

// Unique per run: the server's in-memory DeliveryStore survives between runs,
// so reusing ids from a previous run would be (correctly) rejected as dupes.
const RUN = Date.now().toString(36);
let deliveryCounter = 0;
const sign = (body) => 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');

async function push(payload, { event = 'push', delivery } = {}) {
  const body = JSON.stringify(payload);
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery ?? `test-${RUN}-${++deliveryCounter}`,
      'x-hub-signature-256': sign(body),
    },
    body,
  });
  return { status: res.status, body: await res.json() };
}

const payload = (over = {}) => ({
  ref: 'refs/heads/main',
  after: 'a'.repeat(40),
  repository: {
    id: REPO_ID,
    full_name: 'testowner/testrepo',
    name: 'testrepo',
    owner: { login: 'testowner' },
  },
  head_commit: { id: 'a'.repeat(40), message: 'feat: something' },
  commits: [{ added: ['src/index.ts'], modified: [], removed: [] }],
  pusher: { name: 'tester' },
  sender: { login: 'tester' },
  ...over,
});

const countFor = (projectId) => prisma.deployment.count({ where: { projectId } });

/**
 * The webhook route answers 200 the instant the signature checks out and hands
 * the work off without awaiting it - that is the whole point of the design, so
 * GitHub's ~10s budget is never at risk. It does mean the database is not
 * up to date the moment the response lands, so wait for the row count to stop
 * moving before asserting on it.
 */
async function settle(projectId, quietMs = 250, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  let last = await countFor(projectId);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const now = await countFor(projectId);
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return now;
    }
  }
  return last;
}

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, want ${expected})`);
}

(async () => {
  // Clean slate
  await prisma.deployment.deleteMany({ where: { project: { repoId: REPO_ID } } });
  await prisma.project.deleteMany({ where: { repoId: REPO_ID } });

  // Project.userId is a foreign key, so the push pipeline needs an owner row
  // even though nothing on this path reads it.
  const user = await prisma.user.upsert({
    where: { email: 'e2e@orbitops.local' },
    update: {},
    create: { name: 'E2E Runner', email: 'e2e@orbitops.local' },
  });

  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: 'E2E test app',
      slug: 'e2e-test-app',
      repoId: REPO_ID,
      repoFullName: 'testowner/testrepo',
      githubFullName: 'testowner/testrepo',
      owner: 'testowner',
      repo: 'testrepo',
      branch: 'main',
      hostPort: 5999,
    },
  });
  console.log(`seeded project ${project.id} (repoId ${REPO_ID}, branch main)\n`);

  let before, after;

  // 1. Happy path
  before = await countFor(project.id);
  let r = await push(payload());
  after = await settle(project.id);
  check('ordinary push queues a deployment', after - before, 1);
  check('  responds 200', r.status, 200);
  check('  status is "accepted"', r.body.status, 'accepted');

  // 2. Wrong branch
  before = after;
  await push(payload({ ref: 'refs/heads/other' }));
  after = await settle(project.id);
  check('push to a different branch queues nothing', after - before, 0);

  // 3. skip ci
  before = after;
  await push(payload({ head_commit: { id: 'b'.repeat(40), message: 'docs [skip ci]' } }));
  after = await settle(project.id);
  check('[skip ci] queues nothing', after - before, 0);

  // 4. Tag push
  before = after;
  await push(payload({ ref: 'refs/tags/v1.0.0' }));
  after = await settle(project.id);
  check('tag push queues nothing', after - before, 0);

  // 5. Branch deletion
  before = after;
  await push(payload({ deleted: true, after: '0'.repeat(40) }));
  after = await settle(project.id);
  check('branch deletion queues nothing', after - before, 0);

  // 6. autoDeploy off
  await prisma.project.update({ where: { id: project.id }, data: { autoDeploy: false } });
  before = after;
  await push(payload());
  after = await settle(project.id);
  check('autoDeploy=false queues nothing', after - before, 0);
  await prisma.project.update({ where: { id: project.id }, data: { autoDeploy: true } });

  // 7. watchPaths miss
  await prisma.project.update({ where: { id: project.id }, data: { watchPaths: ['apps/api/**'] } });
  before = after;
  await push(payload({ commits: [{ added: [], modified: ['apps/web/page.tsx'], removed: [] }] }));
  after = await settle(project.id);
  check('watchPaths miss queues nothing', after - before, 0);

  // 8. watchPaths hit
  before = after;
  await push(payload({ commits: [{ added: [], modified: ['apps/api/src/main.ts'], removed: [] }] }));
  after = await settle(project.id);
  check('watchPaths hit queues a deployment', after - before, 1);

  // 9. watchPaths set but commits truncated -> must FAIL OPEN
  before = after;
  await push(payload({ commits: [] }));
  after = await settle(project.id);
  check('empty commit list FAILS OPEN and deploys', after - before, 1);
  await prisma.project.update({ where: { id: project.id }, data: { watchPaths: [] } });

  // 10. Redelivery of the SAME delivery id -> in-memory dedupe
  before = after;
  const dup = `dup-${RUN}`;
  const first = await push(payload(), { delivery: dup });
  const second = await push(payload(), { delivery: dup });
  after = await settle(project.id);
  check('redelivery queues only one', after - before, 1);
  check('  second is reported duplicate', second.body.status, 'duplicate');
  check('  first was accepted', first.body.status, 'accepted');

  // 11. Unknown repo
  before = after;
  await push(payload({ repository: { id: 424242, full_name: 'nobody/nothing' } }));
  after = await settle(project.id);
  check('push for an unregistered repo queues nothing', after - before, 0);

  // 12. Ping
  r = await push({}, { event: 'ping' });
  check('ping is answered with pong', r.body.status, 'pong');

  // 13. Repo rename self-heals via repoId
  await push(
    payload({
      repository: {
        id: REPO_ID,
        full_name: 'testowner/RENAMED',
        name: 'RENAMED',
        owner: { login: 'testowner' },
      },
    }),
  );
  await settle(project.id);
  const renamed = await prisma.project.findUnique({ where: { id: project.id } });
  check('repo rename self-heals repoFullName', renamed.repoFullName, 'testowner/RENAMED');

  // Cleanup
  await prisma.deployment.deleteMany({ where: { projectId: project.id } });
  await prisma.project.delete({ where: { id: project.id } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('ERROR', e);
  await prisma.$disconnect();
  process.exit(1);
});

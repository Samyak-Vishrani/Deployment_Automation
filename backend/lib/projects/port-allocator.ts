import { createServer } from 'node:net';
import { Prisma } from '@prisma/client';

/**
 * Host-port allocation for deployed apps.
 *
 * Two projects must never be handed the same port, and "read the taken ports,
 * pick the lowest free one, insert" is a textbook read-modify-write race: two
 * concurrent creates read the same set and choose the same number. The unique
 * index on Project.hostPort would catch it, but only as a 500 on whichever
 * request loses.
 *
 * So the whole read-and-insert runs inside one transaction holding a Postgres
 * advisory lock. pg_advisory_xact_lock is released automatically when the
 * transaction ends - including on rollback - so a failed create cannot strand
 * the lock the way a manually released one could.
 */

/** Arbitrary but fixed: the lock identity for "allocating a deployment host port". */
const PORT_ALLOCATION_LOCK = 776_1042;

export interface PortRange {
  start: number;
  end: number;
}

export function readPortRange(env: NodeJS.ProcessEnv = process.env): PortRange {
  const start = Number(env.PORT_RANGE_START ?? 5000);
  const end = Number(env.PORT_RANGE_END ?? 5999);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535) {
    throw new Error('PORT_RANGE_START and PORT_RANGE_END must be integers within 1-65535.');
  }
  if (start > end) {
    throw new Error('PORT_RANGE_START must not be greater than PORT_RANGE_END.');
  }
  return { start, end };
}

/**
 * Is this port free on the host right now?
 *
 * The unique index stops two projects colliding with each other, but nothing
 * stops a project colliding with some unrelated process already listening.
 * Checking here converts a confusing `docker run` failure at deploy time into a
 * clear error at create time.
 *
 * Binds 127.0.0.1 specifically, because that is where containers are published.
 */
export function isPortFreeOnHost(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Finds the lowest free port in the range and creates the project with it, all
 * under one advisory lock.
 *
 * Takes a callback rather than returning a port because the port is only truly
 * claimed once the row exists: returning a number and letting the caller insert
 * later would reopen the race the lock exists to close.
 */
export async function createWithAllocatedPort<T>(
  tx: Prisma.TransactionClient,
  range: PortRange,
  create: (hostPort: number) => Promise<T>,
): Promise<T> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PORT_ALLOCATION_LOCK})`;

  const taken = await tx.project.findMany({
    where: { hostPort: { gte: range.start, lte: range.end } },
    select: { hostPort: true },
    orderBy: { hostPort: 'asc' },
  });
  const used = new Set(taken.map((row) => row.hostPort));

  for (let port = range.start; port <= range.end; port++) {
    if (used.has(port)) {
      continue;
    }
    if (!(await isPortFreeOnHost(port))) {
      console.warn(`[ports] Port ${port} is free in the database but in use on the host; skipping.`);
      continue;
    }
    return create(port);
  }

  throw new Error(
    `No free host port in the range ${range.start}-${range.end}. ` +
      'Delete an unused project, or widen PORT_RANGE_START / PORT_RANGE_END.',
  );
}

/**
 * Step 0 of PLAN_PHASE_12: how Render's /v1/logs answers for a running service.
 *
 *   RENDER_API_KEY=... SPIKE_OWNER_ID=tea-... SPIKE_SERVICE_ID=srv-... SPIKE_SECONDS=30 npm run spike:runtime
 *
 * Reads app and request logs of the last 15 minutes, then polls every 2 s for
 * SPIKE_SECONDS (hit the service meanwhile). Prints the rate-limit headers of
 * each poll and writes the pages, key removed, to
 * ../logs/src/providers/__fixtures__/render-runtime-live.json. Read-only.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const key = process.env.RENDER_API_KEY?.trim();
const ownerId = process.env.SPIKE_OWNER_ID?.trim();
const serviceId = process.env.SPIKE_SERVICE_ID?.trim();
const seconds = Number(process.env.SPIKE_SECONDS ?? 30);
const base = (process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1").replace(/\/+$/, "");

if (!key || !ownerId || !serviceId) {
  console.error("Set RENDER_API_KEY, SPIKE_OWNER_ID and SPIKE_SERVICE_ID (optional SPIKE_SECONDS).");
  process.exit(1);
}

async function page(startTime: string) {
  const url = new URL(`${base}/logs`);
  url.searchParams.set("ownerId", ownerId!);
  url.searchParams.append("resource", serviceId!);
  url.searchParams.append("type", "app");
  url.searchParams.append("type", "request");
  url.searchParams.set("direction", "forward");
  url.searchParams.set("limit", "100");
  url.searchParams.set("startTime", startTime);
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
  const limits = ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"].map((h) => `${h}=${response.headers.get(h)}`);
  console.log(response.status, limits.join(" "));
  return (await response.json()) as { logs?: Array<{ timestamp?: string }>; hasMore?: boolean; nextStartTime?: string };
}

async function main() {
  const pages: unknown[] = [];
  let cursor = new Date(Date.now() - 15 * 60_000).toISOString();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const body = await page(cursor);
    pages.push(body);
    console.log(`${body.logs?.length ?? 0} line(s), hasMore=${body.hasMore}`);
    const last = body.logs?.at(-1)?.timestamp;
    if (body.hasMore && body.nextStartTime) cursor = body.nextStartTime;
    else if (last) cursor = last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const dir = join(process.cwd(), "..", "logs", "src", "providers", "__fixtures__");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "render-runtime-live.json"), JSON.stringify(pages, null, 2).split(key!).join("***KEY***"));
  console.log(`${pages.length} page(s) written to ${dir}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});

import { HttpError } from "@/lib/api/http-error";

export class RenderError extends HttpError {
  constructor(message: string, readonly uncertain = false, status = 502) {
    super(message, status, "render_error");
  }
}

export interface RenderService {
  id: string; name: string; ownerId: string; repo?: string;
  serviceDetails?: { url?: string };
}
export interface RenderDeploy {
  id: string; status: string; createdAt: string; finishedAt?: string;
}
export interface RenderLog { id: string; timestamp: string; message: string }

/** Fixed host, bounded requests, no credential-bearing redirects or automatic write retries. */
export class RenderClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid Render path.");
    let response: Response;
    try {
      response = await this.fetcher(`https://api.render.com/v1${path}`, {
        method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new RenderError("Render did not confirm the request. Refresh status before retrying.", method !== "GET");
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: "Render rejected the configuration. Check commands, runtime, region and repository access.",
        401: "Your Render API key is invalid or revoked. Reconnect Render.",
        403: "Render denied access. Check workspace permissions and Render's GitHub repository access.",
        402: "Render requires billing details for this plan. Update billing in Render or choose an available plan.",
        404: "The Render resource was not found. Check repository access and whether the service still exists.",
        409: "Render reports a conflicting operation. Refresh status and check the Render dashboard.",
        429: "Render's rate limit was reached. Wait a minute before refreshing.",
      };
      // Never expose Render's raw error body: it can echo configuration and credentials.
      throw new RenderError(messages[response.status] ?? "Render is temporarily unavailable. Try refreshing later.",
        method !== "GET" && response.status >= 500, response.status === 429 ? 429 : 502);
    }
    try { return await response.json() as T; }
    catch { throw new RenderError("Render returned an unreadable response. Refresh status.", method !== "GET"); }
  }

  async owners() {
    const owners: { id: string; name: string }[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const rows = await this.request<{ owner: { id: string; name: string }; cursor: string }[]>(`/owners?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      owners.push(...rows.map(row => row.owner));
      if (rows.length < 100) return owners;
      cursor = rows.at(-1)!.cursor;
    }
    throw new RenderError("Too many workspaces to list. Use a key with fewer accessible workspaces.");
  }
}

export function deploymentStatus(status: string): string {
  if (status === "live" || status === "deactivated") return "live";
  if (["build_failed", "update_failed", "pre_deploy_failed"].includes(status)) return "failed";
  if (status === "canceled") return "cancelled";
  return "deploying";
}

export const ACTIVE = ["submitting", "uncertain", "deploying"];

export function safeServiceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".onrender.com") && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

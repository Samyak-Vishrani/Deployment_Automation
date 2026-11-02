import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/current-user";
import { badRequest, toErrorResponse } from "@/lib/api/http-error";
import { readBody, requireTrustedOrigin, rateLimit, textField } from "@/lib/render/security";
import { projectView, saveConfig, deploy, sync, acknowledgeUncertain } from "@/lib/render/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ projectId: string }> };
const json = (data: unknown) => NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
export async function GET(_request: Request, context: Context) {
  try {
    const user = await requireUser();
    await rateLimit(user.id, "read", 120);
    return json(await projectView(user.id, (await context.params).projectId));
  } catch (error) { return toErrorResponse(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    const user = await requireUser();
    requireTrustedOrigin(request);
    await rateLimit(user.id, "configure", 20);
    return json(await saveConfig(user.id, (await context.params).projectId, await readBody(request)));
  } catch (error) { return toErrorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const user = await requireUser();
    requireTrustedOrigin(request);
    const body = await readBody(request);
    const { projectId } = await context.params;
    if (body.action === "deploy") {
      await rateLimit(user.id, "deploy", 6);
      return json(await deploy(user.id, projectId, body));
    }
    if (body.action === "sync") {
      await rateLimit(user.id, "sync", 60);
      return json(await sync(user.id, projectId, textField(body, "deploymentId")));
    }
    if (body.action === "acknowledge") {
      await rateLimit(user.id, "deploy", 6);
      return json(await acknowledgeUncertain(user.id, projectId, textField(body, "deploymentId")));
    }
    throw badRequest("Unknown Render action.");
  } catch (error) { return toErrorResponse(error); }
}

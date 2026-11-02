import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/current-user";
import { toErrorResponse } from "@/lib/api/http-error";
import { readBody, requireTrustedOrigin, rateLimit, textField } from "@/lib/render/security";
import { analyze } from "@/lib/render/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireTrustedOrigin(request);
    await rateLimit(user.id, "analysis", 5);
    const body = await readBody(request);
    return NextResponse.json(await analyze(user.id, textField(body, "projectId"), textField(body, "deploymentId")), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return toErrorResponse(error); }
}

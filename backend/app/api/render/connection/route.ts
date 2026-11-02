import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/current-user";
import { toErrorResponse } from "@/lib/api/http-error";
import { readBody, requireTrustedOrigin, rateLimit } from "@/lib/render/security";
import { connect, connectionView, disconnect } from "@/lib/render/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data: unknown) => NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
export async function GET() {
  try { return json(await connectionView((await requireUser()).id)); }
  catch (error) { return toErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireTrustedOrigin(request);
    await rateLimit(user.id, "connection", 10);
    return json(await connect(user.id, await readBody(request)));
  } catch (error) { return toErrorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    requireTrustedOrigin(request);
    await rateLimit(user.id, "connection", 10);
    return json(await disconnect(user.id));
  } catch (error) { return toErrorResponse(error); }
}

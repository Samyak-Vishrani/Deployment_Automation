import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { parseProviderParam, parseTeamBody, parseTokenBody } from "@/lib/providers/credential-input";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

/*
 * The signed-in user's account with one provider. Each method authenticates
 * the user here and forwards to the provider's integration service with the
 * user's id: the service never sees the browser, and the browser never sees
 * the token again after it is saved.
 */

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    parseProviderParam((await context.params).provider);
    return NextResponse.json(await services().vercel.getCredential(user.id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** `{ token }`: validated with the provider, then stored encrypted by the integration service. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    parseProviderParam((await context.params).provider);
    const { token } = parseTokenBody(await request.json().catch(() => null));
    return NextResponse.json(await services().vercel.saveCredential(user.id, token));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** `{ teamId }`: the Vercel team new projects are created in (null = personal scope). */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    parseProviderParam((await context.params).provider);
    const { teamId } = parseTeamBody(await request.json().catch(() => null));
    return NextResponse.json(await services().vercel.setTeam(user.id, teamId));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Forgets the token. Projects already created on Vercel are left there. */
export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    parseProviderParam((await context.params).provider);
    return NextResponse.json(await services().vercel.removeCredential(user.id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

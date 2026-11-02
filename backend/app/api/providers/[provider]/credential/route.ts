import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import {
  parseProviderParam,
  parseRenderPrefsBody,
  parseTeamBody,
  parseTokenBody,
} from "@/lib/providers/credential-input";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

/*
 * The signed-in user's account with one provider (vercel, render). Each method
 * authenticates the user here and forwards to that provider's integration
 * service with the user's id: the service never sees the browser, and the
 * browser never sees the token or key again after it is saved.
 */

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const provider = parseProviderParam((await context.params).provider);
    return NextResponse.json(await services()[provider].getCredential(user.id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** `{ token }`: validated with the provider, then stored encrypted by its integration service. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const provider = parseProviderParam((await context.params).provider);
    const { token } = parseTokenBody(await request.json().catch(() => null));
    return NextResponse.json(await services()[provider].saveCredential(user.id, token));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Vercel: `{ teamId }`, the team new projects are created in (null = personal).
 * Render: `{ ownerId?, region?, plan? }`, the workspace and defaults for new services.
 */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const provider = parseProviderParam((await context.params).provider);
    const body = await request.json().catch(() => null);
    if (provider === "render") {
      return NextResponse.json(await services().render.setPreferences(user.id, parseRenderPrefsBody(body)));
    }
    const { teamId } = parseTeamBody(body);
    return NextResponse.json(await services().vercel.setTeam(user.id, teamId));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Forgets the token or key. What was already created on the provider is left there. */
export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const provider = parseProviderParam((await context.params).provider);
    return NextResponse.json(await services()[provider].removeCredential(user.id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

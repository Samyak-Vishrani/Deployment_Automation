import { NextResponse } from "next/server";
import { badRequest, toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { InvalidRepoUrlError, parseRepoUrl } from "@/lib/github/repo-url";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ owner: string; repo: string }>;
};

/** Branches of a repository the signed-in user can read, for the branch picker. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { owner, repo } = await context.params;

    let parsed;
    try {
      // The same owner/repo rules as a pasted URL, so nothing unvalidated is
      // spliced into a GitHub API path.
      parsed = parseRepoUrl(`https://github.com/${owner}/${repo}`);
    } catch (error) {
      if (error instanceof InvalidRepoUrlError) {
        throw badRequest(error.message);
      }
      throw error;
    }

    return NextResponse.json(await services().githubUser.listBranches(user.id, parsed));
  } catch (error) {
    return toErrorResponse(error);
  }
}

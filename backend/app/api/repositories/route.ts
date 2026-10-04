import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
import { requireUser } from "@/lib/auth/current-user";
import { services } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The repositories the signed-in user can connect: every repository of every
 * installation of the App they can see, read live from GitHub with their own
 * token. `projectId` marks the ones they have already connected.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const rt = services();
    const [listing, projectIds] = await Promise.all([
      rt.githubUser.listRepositories(user.id),
      rt.projects.projectIdsByRepoId(user.id),
    ]);

    return NextResponse.json({
      installUrl: rt.github.installUrl,
      installations: listing.installations,
      repositories: listing.repositories.map((repo) => ({
        ...repo,
        projectId: projectIds.get(repo.id) ?? null,
      })),
      truncated: listing.truncated,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

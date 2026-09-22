import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/require-auth";
import { analyzeProject, AnalysisError } from "@/lib/analysis/analysis.service";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", message: "Authentication required." },
      { status: 401 },
    );
  }

  const { projectId } = await context.params;

  try {
    const result = await analyzeProject(projectId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AnalysisError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.httpStatus },
      );
    }

    console.error("Unexpected analysis error:", error);
    return NextResponse.json(
      { error: "internal_server_error", message: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}

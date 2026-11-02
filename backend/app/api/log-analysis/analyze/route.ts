
import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api/http-error";
// import { requireUser } from "@/lib/auth/current-user";
import { SAMPLE_LOGS } from "@/lib/log-analysis/sample-logs";
import { analyzeDeploymentLogs } from "@/lib/log-analysis/log-analysis.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // Authenticate the user
    // await requireUser();

    // Read request body
    const body = await request.json().catch(() => null);

    if (!body || typeof body.sampleLogId !== "string") {
      return NextResponse.json(
        { error: "sampleLogId is required." },
        { status: 400 }
      );
    }

    // Find the requested sample log
    const sample = SAMPLE_LOGS.find(
      (log) => log.id === body.sampleLogId
    );

    if (!sample) {
      return NextResponse.json(
        { error: "Sample log not found." },
        { status: 404 }
      );
    }

    // Run the complete log-analysis pipeline
    const result = await analyzeDeploymentLogs({
      source: "sample",
      logType: sample.logType,
      projectName: sample.projectName,
      logs: sample.logs,
    });

    // Return analysis result
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

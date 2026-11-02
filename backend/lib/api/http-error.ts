import { NextResponse } from "next/server";
import { GithubError } from "@/lib/github/github-app.service";
import { Prisma } from "@prisma/client";

/**
 * A domain error carrying the status the API should answer with.
 *
 * Stands in for the NestJS exception classes the deployment pipeline was
 * written against. Route handlers catch it once, at the edge, rather than every
 * service returning a Response - which would make the services unusable from
 * anywhere that is not an HTTP handler, the webhook path included.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "request_failed",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string) => new HttpError(message, 400, "bad_request");
export const unauthorized = (message = "Authentication required.") =>
  new HttpError(message, 401, "unauthorized");
export const notFound = (message: string) => new HttpError(message, 404, "not_found");
export const conflict = (message: string) => new HttpError(message, 409, "conflict");

/**
 * Maps anything thrown inside a route handler onto a JSON response.
 *
 * GithubError is translated here rather than wrapped at every call site: it
 * already carries a credential-free message and a status chosen for the
 * frontend, which is exactly the contract HttpError has.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003", "P2025"].includes(error.code)) {
    return NextResponse.json({ error: "conflict", message: "This resource changed or is linked to an existing deployment. Refresh and try again." }, { status: 409 });
  }
  if (error instanceof HttpError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }

  if (error instanceof GithubError) {
    return NextResponse.json(
      { error: "github_error", message: error.message },
      { status: error.status },
    );
  }

  console.error("[api] Unhandled error:", error);
  return NextResponse.json(
    { error: "internal_server_error", message: "An unexpected error occurred." },
    { status: 500 },
  );
}

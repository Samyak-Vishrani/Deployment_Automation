export type ApiErrorBody = {
  error: string;
  message?: string;
  details?: Record<string, unknown>;
};

export function jsonError(message: string, details?: Record<string, unknown>, status = 500): Response {
  const body: ApiErrorBody = { error: "internal_server_error", message };

  if (details) {
    body.details = details;
  }

  return Response.json(body, { status });
}

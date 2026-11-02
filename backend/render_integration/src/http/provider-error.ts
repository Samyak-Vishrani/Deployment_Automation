// Copied from backend/vercel_integration/src/http/provider-error.ts. Each integration service builds and
// deploys on its own, so shared plumbing is copied, not imported. Keep the copies in step.

/**
 * An error from a provider (Render here) whose message is safe to show the
 * user: no token, no request headers, no raw response dump.
 *
 * `status` is what OUR API answers with, chosen for the frontend - not
 * necessarily the provider's status. `code` is the machine-readable reason the
 * frontend branches on (e.g. "render_key_invalid" shows a Reconnect button).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly options: {
      /** Worth trying again later: rate limits, 5xx, network failures. */
      retryable?: boolean;
      /** The token itself was rejected; the credential should be marked invalid. */
      invalidToken?: boolean;
      /** The provider's own error code, for the few places that branch on it. */
      providerCode?: string;
      /** The provider's HTTP status. */
      providerStatus?: number;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get invalidToken(): boolean {
    return this.options.invalidToken ?? false;
  }

  get providerCode(): string | undefined {
    return this.options.providerCode;
  }

  get providerStatus(): number | undefined {
    return this.options.providerStatus;
  }
}

/** Errors our own API raises (validation, not found, conflicts). */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const badRequest = (message: string) => new ServiceError(message, 400, "bad_request");
export const notFound = (message: string) => new ServiceError(message, 404, "not_found");
export const conflict = (message: string) => new ServiceError(message, 409, "conflict");

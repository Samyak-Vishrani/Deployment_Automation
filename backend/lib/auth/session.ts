import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The login session: an HS256 JWT in an httpOnly cookie.
 *
 * The token only carries the user id. Everything shown in the UI (name, avatar,
 * GitHub login) is read from the database on /api/auth/me, so a rename on
 * GitHub or a deleted account takes effect on the next request instead of
 * living on inside a cookie until it expires.
 */

export const SESSION_COOKIE_NAME = "orbitops_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 8;

export type SessionClaims = {
  sub: string;
  iat: number;
  exp: number;
};

const DEV_FALLBACK_SECRET = "orbitops-local-dev-secret";

function secret(): string {
  const value = process.env.AUTH_SECRET?.trim();
  if (value) {
    return value;
  }
  if (process.env.NODE_ENV === "production") {
    // A guessable signing key means anyone can mint a session for any user id.
    throw new Error("AUTH_SECRET must be set in production.");
  }
  return DEV_FALLBACK_SECRET;
}

function sign(input: string): string {
  return createHmac("sha256", secret()).update(input).digest("base64url");
}

export function createSessionToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = { sub: userId, iat: now, exp: now + SESSION_TTL_SECONDS };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign(input)}`;
}

export function verifySessionToken(token: string | undefined): SessionClaims | null {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, payload, received] = parts;
  const expected = sign(`${header}.${payload}`);
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (typeof claims.sub !== "string" || !claims.exp || claims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/** Shared cookie attributes, so setting and clearing can never drift apart. */
export function sessionCookie(value: string, maxAge: number) {
  return {
    name: SESSION_COOKIE_NAME,
    value,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

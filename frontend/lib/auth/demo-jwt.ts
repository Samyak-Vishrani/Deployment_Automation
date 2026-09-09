import { createHmac, timingSafeEqual } from "node:crypto";

export const DEMO_COOKIE_NAME = "orbitops_session";

type DemoClaims = {
  sub: string;
  email: string;
  name: string;
  role: string;
  iat: number;
  exp: number;
};

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

function signingInput(claims: DemoClaims) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  return `${header}.${payload}`;
}

function signature(input: string) {
  return createHmac("sha256", process.env.DEMO_JWT_SECRET ?? "orbitops-local-demo-secret")
    .update(input)
    .digest("base64url");
}

export function createDemoToken() {
  const now = Math.floor(Date.now() / 1000);
  const claims: DemoClaims = {
    sub: "user_demo_01",
    email: "demo@orbitops.dev",
    name: "Aarav Shah",
    role: "platform-admin",
    iat: now,
    exp: now + 60 * 60 * 8,
  };
  const input = signingInput(claims);
  return `${input}.${signature(input)}`;
}

export function verifyDemoToken(token: string | undefined): DemoClaims | null {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, encodedPayload, receivedSignature] = parts;
  const input = `${header}.${encodedPayload}`;
  const expectedSignature = signature(input);
  const receivedBuffer = Buffer.from(receivedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as DemoClaims;
    if (!claims.exp || claims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

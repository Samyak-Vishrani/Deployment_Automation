// Copied from backend/lib/crypto/secret-box.ts. This service never imports from the main backend,
// so it builds and deploys on its own. Keep the two copies in step.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encryption at rest for secrets the database has to hold: GitHub user tokens
 * today, provider tokens and environment variables later.
 *
 * AES-256-GCM, so a value that was edited in the database fails to open rather
 * than decrypting to garbage. Output is `v1.<iv>.<tag>.<ciphertext>`, each part
 * base64url. The leading version names the key: rotating to a new one adds
 * `v2` here and leaves existing rows readable, with no data migration.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

// Development only, and deliberately derived from a public string: anything
// sealed with it is readable by whoever has this file.
const DEV_FALLBACK_KEY = createHash("sha256").update("orbitops-vercel-integration-local-dev-key").digest();

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

function key(): Buffer {
  const value = process.env.ENCRYPTION_KEY?.trim();
  if (value) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== KEY_BYTES) {
      throw new SecretBoxError(`ENCRYPTION_KEY must be ${KEY_BYTES} bytes, base64-encoded.`);
    }
    return decoded;
  }
  if (process.env.NODE_ENV === "production") {
    // A known key means every stored token is effectively plaintext.
    throw new SecretBoxError("ENCRYPTION_KEY must be set in production.");
  }
  return DEV_FALLBACK_KEY;
}

export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function open(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) {
    throw new SecretBoxError("Sealed value is malformed.");
  }
  const [version, iv, tag, ciphertext] = parts;
  if (version !== VERSION) {
    throw new SecretBoxError(`Sealed value uses unknown key version "${version}".`);
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof SecretBoxError) {
      throw error;
    }
    // Never echo the input: it is the secret's ciphertext.
    throw new SecretBoxError("Sealed value could not be opened (tampered, or sealed with another key).");
  }
}

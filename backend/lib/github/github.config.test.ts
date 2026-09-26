import { describe, expect, it } from "vitest";
import { createSign } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { loadGithubConfig, MissingEnvError } from './github.config';

/**
 * A real 2048-bit RSA key in the same PKCS#1 PEM form GitHub issues, generated
 * per run so no secret is committed. Using a real key matters: the bug this
 * guards against produced a PEM that looked plausible and only failed at
 * signing time, with "DECODER routines::unsupported".
 */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const REAL_PEM = privateKey as unknown as string;

/** How a .env file stores it: newlines as the two characters \ and n. */
const escaped = (pem: string) => pem.trim().split('\n').join(String.fromCharCode(92) + 'n');

/**
 * Next.js augments NodeJS.ProcessEnv so NODE_ENV is required, which a partial
 * fixture cannot satisfy. loadGithubConfig only ever reads the four GITHUB_*
 * keys, so the cast is describing the contract rather than hiding a gap.
 */
const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

const baseEnv = (privateKeyValue: string): NodeJS.ProcessEnv =>
  env({
    GITHUB_APP_ID: '123456',
    GITHUB_PRIVATE_KEY: privateKeyValue,
    GITHUB_WEBHOOK_SECRET: 'a'.repeat(40),
    GITHUB_APP_SLUG: 'my-app',
  });

describe('loadGithubConfig', () => {
  it('reports every missing variable at once', () => {
    expect(() => loadGithubConfig(env({}))).toThrow(MissingEnvError);
    try {
      loadGithubConfig(env({}));
    } catch (error) {
      const message = (error as Error).message;
      for (const name of [
        'GITHUB_APP_ID',
        'GITHUB_PRIVATE_KEY',
        'GITHUB_WEBHOOK_SECRET',
        'GITHUB_APP_SLUG',
      ]) {
        expect(message).toContain(name);
      }
    }
  });

  it('rejects a value that is not a PEM private key', () => {
    expect(() => loadGithubConfig(baseEnv('not-a-key'))).toThrow(/PEM private key/);
  });

  it('rejects a non-numeric installation id', () => {
    expect(() =>
      loadGithubConfig({ ...baseEnv(escaped(REAL_PEM)), GITHUB_INSTALLATION_ID: 'abc' }),
    ).toThrow(/must be a number/);
  });

  // The regression. A no-op replace here leaves the PEM on a single line: it
  // still contains BEGIN and PRIVATE KEY, so validation passes and the app
  // starts happily, then every GitHub call fails at JWT signing.
  describe('private key normalisation', () => {
    it('turns escaped newlines back into real ones', () => {
      const config = loadGithubConfig(baseEnv(escaped(REAL_PEM)));
      expect(config.privateKey.trim().split('\n').length).toBe(REAL_PEM.trim().split('\n').length);
      expect(config.privateKey).not.toContain(String.fromCharCode(92) + 'n');
    });

    it('produces a key that can actually SIGN', () => {
      const config = loadGithubConfig(baseEnv(escaped(REAL_PEM)));
      expect(() =>
        createSign('RSA-SHA256').update('payload').sign(config.privateKey, 'base64url'),
      ).not.toThrow();
    });

    it('accepts a key that already has real newlines', () => {
      const config = loadGithubConfig(baseEnv(REAL_PEM));
      expect(() =>
        createSign('RSA-SHA256').update('payload').sign(config.privateKey, 'base64url'),
      ).not.toThrow();
    });

    it('strips surrounding quotes', () => {
      for (const quote of ['"', "'"]) {
        const config = loadGithubConfig(baseEnv(quote + escaped(REAL_PEM) + quote));
        expect(config.privateKey.startsWith('-----BEGIN')).toBe(true);
        expect(() =>
          createSign('RSA-SHA256').update('payload').sign(config.privateKey, 'base64url'),
        ).not.toThrow();
      }
    });
  });
});

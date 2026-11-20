/**
 * Hash of the env vars set on a Vercel project, so an unchanged set (the usual
 * redeploy) costs no API call; and the managed keys that are no longer wanted.
 * Shared with render_integration since Phase 9 (the hash is unchanged).
 */
export { envHash as publicEnvHash, keysToDelete as staleKeys } from "@orbitops/integration-common/env-hash";

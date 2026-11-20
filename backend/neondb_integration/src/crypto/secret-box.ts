import { createSecretBox } from "@orbitops/integration-common/secret-box";

export { SecretBoxError } from "@orbitops/integration-common/secret-box";

/**
 * This service's secret box (backend/integration_common/src/secret-box.ts),
 * which seals Neon API keys. The development seed must not change: keys this
 * service already sealed with the fallback key would stop opening.
 */
const box = createSecretBox({ devFallbackSeed: "orbitops-neondb-integration-local-dev-key" });

export const seal = box.seal;
export const open = box.open;

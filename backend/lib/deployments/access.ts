import { services } from "@/lib/runtime";
import type { Deployment } from "@prisma/client";

/**
 * Loads a deployment and proves the caller owns the project it belongs to.
 *
 * Deployment ids are opaque cuids, but "unguessable" is not an authorisation
 * model - the log stream in particular would otherwise hand any signed-in user
 * another user's build output, secrets redaction notwithstanding.
 */
export async function getOwnedDeployment(
  userId: string,
  deploymentId: string,
): Promise<Deployment> {
  const rt = services();
  const deployment = await rt.deployments.findOne(deploymentId);
  await rt.projects.findOne(userId, deployment.projectId);
  return deployment;
}

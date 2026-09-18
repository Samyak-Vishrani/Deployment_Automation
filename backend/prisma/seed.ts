import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "dev@orbitops.local" },
    update: {},
    create: {
      name: "OrbitOps Developer",
      email: "dev@orbitops.local",
      passwordHash: "development-only-placeholder",
    },
  });

  const project = await prisma.project.upsert({
    where: {
      userId_githubFullName: {
        userId: user.id,
        githubFullName: "orbitops-labs/atlas-api",
      },
    },
    update: {},
    create: {
      userId: user.id,
      name: "Atlas API",
      githubRepoId: "atlas-api",
      githubFullName: "orbitops-labs/atlas-api",
      githubUrl: "https://github.com/orbitops-labs/atlas-api",
      defaultBranch: "main",
    },
  });

  await prisma.projectComponent.upsert({
    where: {
      id: "component-atlas-api-web",
    },
    update: {},
    create: {
      id: "component-atlas-api-web",
      projectId: project.id,
      type: "web",
      framework: "nextjs",
      language: "typescript",
      path: "apps/web",
      packageManager: "npm",
      detectedVersion: "16.x",
      confidence: 0.94,
    },
  });

  await prisma.projectComponent.upsert({
    where: {
      id: "component-atlas-api-api",
    },
    update: {},
    create: {
      id: "component-atlas-api-api",
      projectId: project.id,
      type: "api",
      framework: "node",
      language: "typescript",
      path: "apps/api",
      packageManager: "npm",
      detectedVersion: "20.x",
      confidence: 0.9,
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

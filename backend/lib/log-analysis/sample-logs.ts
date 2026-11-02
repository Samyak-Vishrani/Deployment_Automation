
export type SampleLog = {
  id: string;
  name: string;
  logType: "build" | "runtime" | "deployment";
  projectName: string;
  logs: string;
  expectedFailureType: string;
};

export const SAMPLE_LOGS: SampleLog[] = [
  {
    id: "LOG-001",
    name: "Missing Dependency",
    logType: "build",
    projectName: "demo-next-app",
    logs: `
> demo-next-app@1.0.0 build
> next build

Failed to compile.

Module not found: Can't resolve 'axios'

Build failed with exit code 1.
    `,
    expectedFailureType: "MISSING_DEPENDENCY",
  },

  {
    id: "LOG-002",
    name: "TypeScript Compilation Error",
    logType: "build",
    projectName: "demo-typescript-app",
    logs: `
> demo-typescript-app@1.0.0 build
> tsc

src/utils.ts:12:5 - error TS2322:
Type 'string' is not assignable to type 'number'.

Found 1 error.
Build failed.
    `,
    expectedFailureType: "TYPESCRIPT_ERROR",
  },

  {
    id: "LOG-003",
    name: "Missing Environment Variable",
    logType: "runtime",
    projectName: "demo-api",
    logs: `
Starting application...

Error: DATABASE_URL is not defined.
    at connectDatabase (src/database.ts:10:15)

Application crashed.
    `,
    expectedFailureType: "MISSING_ENV_VARIABLE",
  },

  {
    id: "LOG-004",
    name: "Docker Build Failure",
    logType: "deployment",
    projectName: "demo-docker-app",
    logs: `
Step 4/8 : COPY package.json package-lock.json ./
COPY failed: file not found in build context
Docker build failed with exit code 1.
    `,
    expectedFailureType: "DOCKER_BUILD_ERROR",
  },

  {
    id: "LOG-005",
    name: "Port Already in Use",
    logType: "runtime",
    projectName: "demo-node-api",
    logs: `
Starting server on port 3000...

Error: listen EADDRINUSE: address already in use :::3000

Server startup failed.
    `,
    expectedFailureType: "PORT_CONFLICT",
  },

  {
    id: "LOG-006",
    name: "Database Connection Failure",
    logType: "runtime",
    projectName: "demo-db-app",
    logs: `
Connecting to PostgreSQL...

Error: connect ECONNREFUSED 127.0.0.1:5432

Database connection failed.
Application terminated.
    `,
    expectedFailureType: "DATABASE_CONNECTION_ERROR",
  },

  {
    id: "LOG-007",
    name: "Build Timeout",
    logType: "build",
    projectName: "demo-slow-app",
    logs: `
Starting Docker build...

Installing dependencies...
Running production build...

Build process exceeded timeout limit.
Deployment cancelled.
    `,
    expectedFailureType: "BUILD_TIMEOUT",
  },

  {
    id: "LOG-008",
    name: "Runtime Application Crash",
    logType: "runtime",
    projectName: "demo-crash-app",
    logs: `
Application started successfully.

GET /api/users 500

TypeError: Cannot read properties of undefined
    at getUsers (src/controllers/users.ts:25:10)

Application crashed.
    `,
    expectedFailureType: "RUNTIME_ERROR",
  },
  
  {
    id: "LOG-009",
    name: "Database Logs With Exposed Credentials",
    logType: "runtime",
    projectName: "demo-db-secret-app",
    logs: `
      Connecting to database...

      DATABASE_URL=postgresql://admin:SuperSecret123@localhost:5432/app

      password = "MyDatabasePassword"

      Error: connect ECONNREFUSED 127.0.0.1:5432
      Database connection failed.
    `,
    expectedFailureType: "DATABASE_CONNECTION_ERROR",
  },

  {
    id: "LOG-010",
    name: "Inconsistent Whitespace",
    logType: "build",
    projectName: "demo-whitespace-app",
    logs: `
        
          > demo-app@1.0.0 build

        > next build

        
        Module not found:   Can't resolve 'axios'


        Build failed with exit code 1.
        
    `,
    expectedFailureType: "MISSING_DEPENDENCY",
  },

  {
    id: "LOG-011",
    name: "Mixed Structured and Plain Logs",
    logType: "runtime",
    projectName: "demo-mixed-logs-app",
    logs: `
      {"timestamp":"2026-10-20T10:30:00Z","level":"info","message":"Application started"}

      {"timestamp":"2026-10-20T10:30:01Z","level":"error","message":"Cannot read properties of undefined"}

      ERROR: Application crashed.

      {"level":"error","message":"Internal server error"}
    `,
    expectedFailureType: "RUNTIME_ERROR",
  },

  {
    id: "LOG-012",
    name: "Inconsistent Environment Variable Formatting",
    logType: "runtime",
    projectName: "demo-env-app",
    logs: `
      Starting application...

      DATABASE_URL   =   "postgresql://user:secret123@localhost:5432/app"

      Error: DATABASE_URL is not defined

      Application crashed.
    `,
    expectedFailureType: "MISSING_ENV_VARIABLE",
  },

];

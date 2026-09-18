# OrbitOps backend

This backend is the separate Next.js API layer for the deployment automation platform.

## Architecture

- Frontend: Next.js on port 3000
- Backend: Next.js on port 3001
- Database: PostgreSQL via Prisma

Browser
↓
Frontend :3000
↓ HTTP
Backend :3001
↓
Prisma
↓
PostgreSQL

## Local development

Terminal 1:

```bash
cd frontend
npm run dev
```

Terminal 2:

```bash
cd backend
npm run dev
```

## Environment

Copy `.env.example` to `.env` and set your local database URL:

```bash
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/DATABASE_NAME"
FRONTEND_URL="http://localhost:3000"
```

## Scripts

- `npm run dev` - start the backend on port 3001
- `npm run build` - production build
- `npm run lint` - ESLint check
- `npx prisma validate` - validate the Prisma schema
- `npx prisma migrate status` - check migration state without resetting the database

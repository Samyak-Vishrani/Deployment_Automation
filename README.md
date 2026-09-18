# Deployment Automation

## Architecture

Frontend:

- Next.js
- port 3000

Backend:

- Next.js
- port 3001
- Prisma

Database:

- PostgreSQL

Architecture:

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

The frontend communicates with the backend over HTTP using a small centralized API client. The frontend remains mock-driven for this phase and does not implement auth, GitHub integrations, analysis, or deployment flows.

## Environment configuration

Frontend environment:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
```

Backend environment:

```bash
FRONTEND_URL=http://localhost:3000
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/DATABASE_NAME"
```

This project keeps the frontend UI independent from the backend API layer while preserving the existing PostgreSQL database and Prisma migration history.

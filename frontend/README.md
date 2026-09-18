# OrbitOps frontend

The frontend remains a standalone Next.js application using the mock platform provider.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Frontend environment

Set the backend target in `.env.local` or `.env` if needed:

```bash
NEXT_PUBLIC_DATA_MODE=mock
NEXT_PUBLIC_API_URL=http://localhost:3001
```

The frontend communicates with the backend via the centralized API client in `lib/api`, which uses native `fetch` and keeps the mock UI and mock provider unchanged during this phase.

## Backend connection

The backend app runs on:

- `http://localhost:3001`

The frontend uses `NEXT_PUBLIC_API_URL` to construct requests to the backend without hard-coding localhost values across the app.

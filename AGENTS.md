# AGENTS.md

## Cursor Cloud specific instructions

### What this is
Kuja AI Platform — a single Node.js/Express service (`backend/server.js`) that serves a static frontend (`frontend/`) and exposes a JSON API under `/api/*`. Data is stored in a local SQLite database via `better-sqlite3` at `backend/data/kuja.db` (created automatically on first run; the schema and an admin + demo client are seeded on startup). There is no separate frontend build step.

### Running
- Start the server from the `backend/` directory: `node server.js` (or `npm start`). It listens on `http://localhost:3000`.
- The root `npm start` also works (`node backend/server.js`).
- The app requires a `backend/.env` file. Copy `backend/.env.example` to `backend/.env`. At minimum set `JWT_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` — without `ADMIN_PASSWORD` set, startup seeding throws (it hashes an undefined password).
- On startup the app seeds an admin account (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) and a permanent demo client "Kuja AI" with a fixed api_key `kuja_7828916b91d242599da5efe7692840fa`. Log in at `/` (Admin tab) with the admin credentials.

### Optional integrations (safe to leave unset in dev)
- SMTP (`SMTP_*`, `EMAIL_FROM`): lead/booking email notifications. Sending is best-effort — failures are caught and logged, never fatal.
- Google Calendar (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`): only exercised by the client "connect calendar" OAuth flow. The rest of the app runs fine without it.

### Lint / test / build
- There is no linter, no test suite, and no build step configured in this repo. "Build" per `package.json` just runs `cd backend && npm install`.

### Gotchas
- SQLite uses WAL mode, so `backend/data/` will contain `kuja.db`, `kuja.db-shm`, and `kuja.db-wal`. This directory is gitignored and safe to delete to reset all data (it will be re-seeded on next startup).
- `better-sqlite3` is a native module; if the Node version changes you may need to reinstall dependencies so the native binding is rebuilt.

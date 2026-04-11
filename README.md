# Premium Pricing App (Framework)

## STOP - Read This First

Before doing anything else, read [MUST_READ_FIRST.md](./MUST_READ_FIRST.md).

Do not edit code, deploy, rollback, restore, or run destructive scripts until you understand and follow that file.

## Easiest way to open it

- Double-click [OPEN_APP.bat](./OPEN_APP.bat)
- Choose:
  - `1` for Web Preview (easiest)
  - `2` for Phone/iPad with Expo Go

If the launcher says Node.js is missing, install Node.js LTS from [nodejs.org](https://nodejs.org) and run the launcher again.

## What is implemented

- Role entry shell (`Marketer` vs `Admin`)
- Marketer flow:
  - Brand search by first 3+ letters
  - Active brand results only (names only)
  - Brand detail with active ticket lines
  - Add lines to cart, qty controls, remove line, clear all
  - Per-line retail/CMA totals
  - Bottom totals:
    - Retail Total
    - Guest Starting Total
    - Marketer Contribution
    - Guest Final Total
  - Two-way pricing math between contribution and guest final
  - Guardrails (clamping and warnings)
- Admin flow:
  - Brand list with active/inactive/all filters
  - Add/edit brand name
  - Duplicate brand
  - Activate/inactivate brand
  - Delete total (brand + all ticket lines) with confirmation
  - Ticket line add/edit/duplicate/activate/inactivate/delete with confirmation
  - Admin user list and add/toggle active
  - Assistant import/review placeholder (prepare draft extraction from pasted text)
- Data model seeded in local app state (not hardcoded in UI components)

## Project structure

- `App.tsx` main app shell and role routing
- `src/context/AppDataContext.tsx` in-memory data layer and CRUD actions
- `src/screens/MarketerWorkspace.tsx` marketer UX and cart math wiring
- `src/screens/AdminWorkspace.tsx` admin UX
- `src/utils/pricing.ts` pricing and guardrail logic
- `src/data/seed.ts` initial sample data

## Next phase (from handoff)

- Wire persistent backend/database
- Add real auth
- Build image/screenshot upload + extraction review workflow
- Import real premium data after framework validation

## Remote sync (HTML app)

- The HTML app now includes an Admin tab called `Remote Sync`.
- It supports:
  - Load `published` snapshot from Supabase (marketer read path)
  - Load `draft` snapshot (admin)
  - Save local catalog -> `draft`
  - Publish `draft` -> `published`
  - Import Spreadsheet CSV -> `draft`
- SQL bootstrap for Supabase is in:
  - `SUPABASE_REMOTE_SETUP.sql`

### Expected sheet CSV columns

- `brand`, `category`, `ticket_label`, `qualifier_text`, `info_text`
- `retail_price`, `cma_price`, `active`, `pregift`
- `bogo_enabled`, `bogo_limit`, `sort_order`

You can also use common aliases like `brand_name`, `ticket`, `retail`, and `cma`.

## Portable Deployment

This app is deployment-agnostic for frontend hosting.  
Vercel can be used for demo hosting, but it is not required for production.

### Required environment variables

Frontend (`npm run html:serve`):

- `HOST` (default: `0.0.0.0`)
- `PORT` (default: `4173`)
- `APP_API_BASE_URL` (required for authority actions, example: `http://localhost:8787`)

Backend (`npm run backend:start`):

- `API_HOST` (default: `0.0.0.0`)
- `API_PORT` (default: `8787`)
- `DATABASE_URL` (example: `postgres://postgres:postgres@127.0.0.1:5432/marketingtool`)
- optional `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- `APP_DB_SSL` (`true` when required by managed Postgres)
- `APP_CORS_ORIGIN` (default: `http://localhost:4173`)
- `APP_SESSION_SECRET` (required outside dev)
- `APP_COOKIE_SECURE` (`true` in HTTPS production)
- `APP_COOKIE_SAME_SITE` (`lax` by default; use `none` for cross-site frontend/backend domains)
- `APP_TRUST_PROXY` (optional; set to `1` or `true` when behind reverse proxy)
- `APP_SESSION_TTL_MS` (optional; defaults to 12 hours)
- `TEST_API_BASE_URL` (optional helper for simulation scripts, default `http://127.0.0.1:8787`)

### Local run instructions

1. Install dependencies:
   - `npm install`
2. Start Postgres (local or Docker) and ensure `DATABASE_URL` is set.
3. Run DB migration + seed (first time):
   - `npm run db:migrate`
   - `npm run db:seed`
4. Optional one-time import from legacy file DB:
   - `npm run db:import-json`
   - or `npm run db:import-json -- C:\\path\\to\\db.json`
5. Start backend:
   - `npm run backend:start`
6. In another terminal, start frontend:
   - `APP_API_BASE_URL=http://localhost:8787 npm run html:serve`
   - PowerShell alternative:
     - `$env:APP_API_BASE_URL='http://localhost:8787'; npm run html:serve`
7. Open:
   - `http://localhost:4173/premium_pricing_clickable.html`
8. Run required backend tests:
   - `npm run test:backend`
9. Create a durable user backup anytime:
   - `npm run users:backup`
10. Run the automated backup wrapper manually anytime:
   - `npm run users:backup:auto`
   - this runs the existing backup flow, writes a timestamped backup, and appends a summary log to `backups/users/logs/users-backup-auto.log`
11. Register the once-daily Windows Task Scheduler job:
   - `npm run users:backup:auto:register`
   - default schedule is `2:30 AM` local time and uses `scripts/run-users-backup-auto.ps1`
12. Validate a specific backup against the live DB:
   - `npm run users:validate -- backups/users/users-export-<timestamp>.json`
13. Prove restore apply on a safe in-memory target:
   - `npm run users:restore:proof -- backups/users/users-export-<timestamp>.json`
14. Run release preflight before deploy/rollback/migration:
   - `npm run release:preflight`
15. Run a truth audit if any account appears missing:
   - `npm run users:audit -- --browser-profile .tmp_chrome_profile_live <identifier>`
16. Run the one-command panic report anytime you need counts plus backup status:
   - `npm run users:panic-check -- --browser-profile .tmp_chrome_profile_live --backend-base-url https://marketingtool-backend-445z.onrender.com`
17. Run release postdeploy verification after deploy:
   - `npm run release:postdeploy`
   - for production sign-in smoke checks, set `RELEASE_SMOKE_USERS_FILE=support/release-smoke-users.example.json` with real credentials first
18. Optional scenario simulation (backend must be running):
   - `npm run sim:scenarios`
19. Optional lightweight load simulation:
   - `npm run sim:load`

### Docker run instructions

Using Compose:

1. Update environment values in `docker-compose.yml` (especially `APP_SESSION_SECRET`).
2. Run:
   - `docker compose up --build`
3. Open:
   - `http://localhost:4173/premium_pricing_clickable.html`
4. Backend API:
   - `http://localhost:8787/api/health`

Using Docker directly:

- `docker build -t marketingtool-web .`
- `docker build -t marketingtool-api -f Dockerfile.backend .`
- `docker network create marketingtool-net`
- `docker run --rm --name marketingtool-api --network marketingtool-net -p 8787:8787 -e APP_SESSION_SECRET=change-me marketingtool-api`
- `docker run --rm --name marketingtool-web --network marketingtool-net -p 4173:4173 -e APP_API_BASE_URL=http://marketingtool-api:8787 marketingtool-web`

### Vercel deploy instructions (demo)

1. Use `npm run deploy:production`.
2. Do not run raw Vercel production deploy commands by hand.
3. The production target is defined in `scripts/deploy-config.mjs`.
4. Ensure `runtime-config.js` is included in deployed files and points `apiBaseUrl` at your backend URL.
5. Do not place service-role/write secrets in frontend files.

### What changes for enterprise hosting

- Put app behind company reverse proxy/domain (nginx, ingress, load balancer, etc.).
- Keep write/service keys only in backend/secret manager (never in browser or repo files).
- Set frontend `APP_API_BASE_URL` (or `runtime-config.js` `apiBaseUrl`) to company backend URL.
- Use company-managed Postgres via `DATABASE_URL`.

## Vendor Lock-In Risks

- Legacy Supabase SQL/bootstrap docs still exist under `supabase/` and `SUPABASE_*.sql`.
  - Replacement path: remove after migration freeze or map them to company-managed DB migrations.
- Expo/Electron shell files remain in repo for alternate app packaging.
  - Replacement path: deploy only backend + static HTML bundle if company does not need those shells.

## Handoff Docs

- `PORTABILITY_NOTES.md`
- `ENTERPRISE_HANDOFF.md`
- `TESTING_GUIDE.md`
- `RESET_AND_SEED_GUIDE.md`
- `docs/RELEASE_SAFETY.md`

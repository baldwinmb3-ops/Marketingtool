# Release Safety

This project now treats user durability as a release gate, not a best-effort check.

## Source Of Truth

- Durable user records live in Postgres `users`.
- Browser `localStorage` is not authoritative.
- `pendingUserCloudOps` and `deletedUserTombstones` are queue state only.
- `auth_lookup` only returns `active` accounts, so an inactive durable user can look "missing" in sign-in checks unless you also inspect Postgres-backed `/api/users` or a backup export.

## Truth Audit

Run this before deciding whether an account was lost:

- `npm run users:audit -- --browser-profile .tmp_chrome_profile_live <identifier>`

The audit reports:

- persisted active user count
- persisted inactive user count
- persisted deleted user count
- local/browser-only user count
- queued/pending user operation count
- DB-only versus local-only identities
- inactive durable users that can fail `auth_lookup`

For a one-command panic report with backup freshness included:

- `npm run users:panic-check -- --browser-profile .tmp_chrome_profile_live --backend-base-url https://marketingtool-backend-445z.onrender.com`

`users:panic-check` prints:

- total persisted users broken out by active / inactive / deleted
- DB vs local vs queued counts
- the latest validated backup file and timestamp
- a stale-backup warning if the newest backup is older than the configured threshold

## Required Predeploy Steps

Run these before any deploy, rollback, or migration:

1. `npm run release:preflight`
2. Confirm the generated report shows expected user counts.
3. Save the generated JSON + CSV user backup files from `backups/users/predeploy`.

`release:preflight` automatically:

- snapshots total user counts from Postgres
- picks sample users for existence checks
- writes a timestamped JSON backup
- writes a timestamped CSV backup
- validates the backup against the live DB counts
- keeps the most recent 10 predeploy backup sets automatically

## Required Postdeploy Steps

Run this immediately after deploy:

1. `npm run release:postdeploy`

`release:postdeploy` automatically verifies:

- backend `/api/health`
- user counts unchanged versus predeploy snapshot
- sampled users still exist in Postgres
- sign-in still works for smoke-test accounts

Smoke-test credentials can be supplied with:

- `RELEASE_SMOKE_USERS_FILE=<path-to-json>`
- or `RELEASE_SMOKE_USERS_JSON='[{"identifier":"...","password":"...","role":"admin"}]'`
- example file format: `support/release-smoke-users.example.json`

In production-like environments, postdeploy sign-in verification refuses to guess. If smoke credentials are not provided, the script fails honestly and tells you to set them.

Only local/dev postdeploy checks fall back to seeded smoke accounts:

- `ADMIN1001 / Admin123A / admin`
- `ADMIN2001 / Assist123A / admin`
- `MARK1001 / Marketer123A / marketer`

## Backup Export

One-click durable export:

- `npm run users:backup`

Output:

- `backups/users/users-export-<timestamp>.json`
- `backups/users/users-export-<timestamp>.csv`
- `backups/users/users-export-<timestamp>.validation.json`
- `backups/users/latest-backup-status.json`

The JSON export includes every field required to restore user accounts, including password hashes.

Validate a backup against the current live DB:

- `npm run users:validate -- backups/users/users-export-<timestamp>.json`

Automatic retention:

- the latest 10 backup sets are kept automatically
- older JSON/CSV/validation triplets are pruned after a successful new export

Backup visibility:

- the latest validated backup summary is written to `backups/users/latest-backup-status.json`
- backend system health now includes `runtime.latestBackup` when a local validated backup is present

## Restore Import

Dry run first:

- `npm run users:import -- backups/users/users-export-<timestamp>.json`

Apply only after reviewing the dry-run report:

- `npm run users:import -- backups/users/users-export-<timestamp>.json --apply`

Safe restore-apply proof on an isolated in-memory target:

- `npm run users:restore:proof -- backups/users/users-export-<timestamp>.json`

Import behavior:

- creates missing users
- updates matching users by `id`, `wwid`, or `email`
- skips unchanged users
- reports ambiguous conflicts instead of guessing
- preserves existing IDs when matching by WWID/email to avoid breaking references
- automatically creates a fresh validated guard backup before `--apply`

Dry-run reports include:

- `summary.create`
- `summary.update`
- `summary.unchanged`
- `summary.conflict`
- per-user create/update/conflict details

## Rollback Types

### Frontend-only rollback

Use only for static app/UI issues.

- Example: `npx vercel rollback <deployment-url> --yes`

Rules:

- must run `npm run release:preflight` immediately before the rollback
- must not run DB scripts
- must not run user restore/import
- must not assume browser state equals Postgres state
- must run `npm run release:postdeploy` afterward

### Backend-only rollback

Use only for server/API regressions.

Rules:

- must run `npm run release:preflight` immediately before the rollback
- deploy a prior backend commit/service revision
- do not run `db:reset`
- do not run `db:seed --force`
- do not run restore/import unless database state is actually damaged
- run `npm run release:postdeploy` after rollback

### Database restore

Use only when Postgres data is damaged, missing, or intentionally restored.

Rules:

- export a fresh backup first if the DB is still reachable
- run import dry-run first
- review create/update/conflict report
- apply import only after review
- run `npm run release:postdeploy` after restore

## Dangerous Commands

These are blocked against production-like databases unless you explicitly acknowledge a verified backup:

- `npm run db:reset`
- `npm run db:seed -- --force`
- `npm run db:import-json`

These now also require an exact action confirmation token:

- `npm run db:reset -- --confirm db-reset:i-understand-this-destroys-data`
- `npm run db:seed -- --force --confirm db-seed-force:i-understand-this-destroys-data`
- `npm run db:import-json -- <file> --confirm db-import-json:i-understand-this-destroys-data`

These commands now also auto-create a fresh validated local user backup before they proceed:

- `npm run db:reset`
- `npm run db:seed -- --force`
- `npm run db:import-json`
- `npm run users:import -- <file> --apply`

Override only after verified backup:

- `APP_ALLOW_DESTRUCTIVE_DB_RESET=YES_I_HAVE_A_BACKUP`

Additional operator-safety rules:

- `db:import-json` now refuses to run without an explicit file path
- destructive commands print the target host and destructive scope before proceeding
- exact confirmation tokens are required even in local/dev to reduce accidental execution

## Production Auto-seed Rule

Boot-time auto-seeding is now disabled by default for production-like databases.

- local/dev defaults to `APP_DB_SEED_MODE=if-empty`
- production-like DBs default to `APP_DB_SEED_MODE=never`

If you really need boot-time seeding, set:

- `APP_DB_SEED_MODE=if-empty`

Do not enable that on production unless you explicitly want demo seed users to appear in an empty database.

## Non-Durable Runtime Rule

Boot-time pg-mem fallback is now disabled by default for production-like database environments.

- local/dev can still fall back automatically on recoverable DB boot failures
- production-like environments must explicitly opt in with `APP_BOOT_MEMORY_FALLBACK=true`

The explicit memory backend is also blocked in production-like environments unless you intentionally acknowledge the non-durable mode:

- `APP_ALLOW_EXPLICIT_MEMORY_ONLY_RUNTIME=YES_I_UNDERSTAND_THIS_IS_NOT_DURABLE`

When pg-mem fallback or explicit memory mode is active, `/api/health` and `/version.json` now report the runtime as non-durable and non-authoritative.

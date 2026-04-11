# HTML App Release Control

## Source Of Truth

- Primary runtime source: `C:\Users\Dell\Documents\projects\marketingtool\premium_pricing_clickable.html`
- Official Windows launcher: `C:\Users\Dell\Documents\projects\marketingtool\OPEN_HTML_APP.bat`
- Official local HTML server: `C:\Users\Dell\Documents\projects\marketingtool\scripts\serve-html.mjs`
- Official Electron runtime entry: `C:\Users\Dell\Documents\projects\marketingtool\desktop\main.cjs`
- Official deploy target config: `C:\Users\Dell\Documents\projects\marketingtool\scripts\deploy-config.mjs`

## Generated Output

- `C:\Users\Dell\Documents\projects\marketingtool\public\premium_pricing_clickable.html` is generated output only.
- `npm run build` copies the root HTML app into `public/`.
- `npm run deploy:production` is the only blessed production deploy entrypoint.
- Do not run raw Vercel production deploy commands by hand from docs or handoffs.
- The deploy script reads the production target from `scripts/deploy-config.mjs`, deploys, moves the configured alias, and fails if live production verification does not show the new build.
- The generated runtime manifest/version files are:
  - `C:\Users\Dell\Documents\projects\marketingtool\runtime-config.js`
  - `C:\Users\Dell\Documents\projects\marketingtool\version.json`

## Duplicate Policy

- Active package/test copies must not contain their own live app logic.
- Non-primary copies are wrapper files that clearly identify themselves and redirect back to the root source when possible.
- Historical copies under `backups/` are archival snapshots and are not part of the live runtime pipeline.

## Drift Prevention

- The live app shows a visible build marker in the UI.
- Startup logs the loaded file identity, build id, catalog version, and Wonder Works Pre-Gift status.
- Startup also clears stale same-origin service workers/caches once per build.
- Local storage now writes to the primary v2 key and removes the legacy v1 copy on save.

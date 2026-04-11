import { spawn, spawnSync } from 'node:child_process';

const useWindows = process.platform === 'win32';
const npmCmd = useWindows ? 'npm.cmd' : 'npm';
const args = process.argv.slice(2);
const clean = args.includes('--clean');
const apiBaseUrl = (process.env.APP_API_BASE_URL || 'http://127.0.0.1:8787').trim();

function runSync(scriptName) {
  const result = spawnSync(npmCmd, ['run', scriptName], { stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runAsync(scriptName, extraEnv = {}) {
  return spawn(npmCmd, ['run', scriptName], {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
}

if (clean) {
  console.log('Resetting database before startup...');
  runSync('db:reset');
}

console.log(`Starting backend + frontend with APP_API_BASE_URL=${apiBaseUrl}`);
const backend = runAsync('backend:start');
const frontend = runAsync('html:serve', { APP_API_BASE_URL: apiBaseUrl });

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    backend.kill('SIGTERM');
  } catch {}
  try {
    frontend.kill('SIGTERM');
  } catch {}
  process.exit(0);
}

backend.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`backend exited with code ${code}`);
    shutdown();
  }
});

frontend.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`frontend exited with code ${code}`);
    shutdown();
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

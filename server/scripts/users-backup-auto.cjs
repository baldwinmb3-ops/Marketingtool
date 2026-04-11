const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function stripQuotes(value) {
  const text = String(value || '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function resolveEnvFile(repoRoot) {
  const explicit = stripQuotes(process.env.USERS_BACKUP_ENV_FILE || '');
  if (explicit) return explicit;
  return path.join(repoRoot, '.tmp_render_export', 'marketingtool-backend.env');
}

function loadEnvFile(envFilePath, targetEnv) {
  if (!envFilePath || !fs.existsSync(envFilePath)) return { loaded: false, file: envFilePath };
  const lines = fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1);
    if (!key || Object.prototype.hasOwnProperty.call(targetEnv, key)) return;
    targetEnv[key] = stripQuotes(rawValue);
  });
  return { loaded: true, file: envFilePath };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendLog(logPath, entry) {
  ensureDir(path.dirname(logPath));
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function runBackup(repoRoot, env) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm run --silent users:backup'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
    });
  }
  return spawnSync('npm', ['run', '--silent', 'users:backup'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
}

function parseBackupOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error('users:backup produced no stdout to parse.');
  }
  return JSON.parse(text);
}

function main() {
  const repoRoot = resolveRepoRoot();
  const logsDir = path.join(repoRoot, 'backups', 'users', 'logs');
  const logPath = path.join(logsDir, 'users-backup-auto.log');
  const env = { ...process.env };
  const envFilePath = resolveEnvFile(repoRoot);
  const envLoad = loadEnvFile(envFilePath, env);
  if (!String(env.APP_DB_SSL || '').trim()) env.APP_DB_SSL = 'true';
  if (!String(env.NODE_ENV || '').trim()) env.NODE_ENV = 'production';

  const startedAt = new Date().toISOString();
  const result = runBackup(repoRoot, env);
  const stderr = String(result.stderr || '').trim();

  if (result.error || result.status !== 0) {
    const failure = {
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      envFile: envLoad.loaded ? envLoad.file : null,
      command: 'npm run --silent users:backup',
      exitCode: Number.isInteger(result.status) ? result.status : 1,
      stdout: String(result.stdout || '').trim(),
      stderr,
      launchError: result.error ? String(result.error.message || result.error) : null,
    };
    appendLog(logPath, failure);
    console.error(JSON.stringify(failure, null, 2));
    process.exit(result.status || 1);
  }

  let payload;
  try {
    payload = parseBackupOutput(result.stdout);
  } catch (error) {
    const failure = {
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      envFile: envLoad.loaded ? envLoad.file : null,
      command: 'npm run --silent users:backup',
      exitCode: 1,
      stdout: String(result.stdout || '').trim(),
      stderr,
      parseError: String((error && error.message) || error || 'Could not parse users:backup output'),
    };
    appendLog(logPath, failure);
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }

  const summary = {
    ok: !!payload.ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    envFile: envLoad.loaded ? envLoad.file : null,
    filename: path.basename(payload.files && payload.files.json ? payload.files.json : ''),
    file: payload.files && payload.files.json ? payload.files.json : '',
    timestamp: String(payload.exportedAt || '').trim(),
    count: Number(payload.counts && payload.counts.total) || 0,
    validationOk: !!(payload.validation && payload.validation.ok),
    stderr: stderr || null,
  };
  appendLog(logPath, summary);
  console.log(JSON.stringify({ ...summary, logFile: logPath }, null, 2));
}

main();

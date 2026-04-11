const fs = require('fs');
const path = require('path');

const { buildUsersBackupSnapshot, usersBackupToCsv, loadUsersBackupFile, summarizeUsers } = require('./user-backup.cjs');
const { databaseConnectionInfo } = require('./db-safety.cjs');

const DEFAULT_BACKUP_KEEP = 10;

function envInt(name, fallback) {
  const raw = Number.parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function backupRetentionCount() {
  return envInt('APP_USER_BACKUP_KEEP', DEFAULT_BACKUP_KEEP);
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveBackupFilePaths(outDir, prefix, stamp, options = {}) {
  const dataLabel = String(options.dataLabel || '').trim();
  const base = path.join(path.resolve(outDir), `${prefix}-${stamp}`);
  return {
    json: dataLabel ? `${base}.${dataLabel}.json` : `${base}.json`,
    csv: dataLabel ? `${base}.${dataLabel}.csv` : `${base}.csv`,
    validation: `${base}.validation.json`,
  };
}

function backupStatusFilePath(baseDir = path.join(process.cwd(), 'backups', 'users')) {
  return path.join(path.resolve(baseDir), 'latest-backup-status.json');
}

function fileInfo(filePath) {
  const stats = fs.statSync(filePath);
  return {
    path: filePath,
    sizeBytes: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
  };
}

function ensureUniqueStamp(outDir, prefix, stamp, options = {}) {
  let candidate = String(stamp || '').trim() || compactTimestamp();
  let suffix = 1;
  while (true) {
    const files = resolveBackupFilePaths(outDir, prefix, candidate, options);
    if (!fs.existsSync(files.json) && !fs.existsSync(files.csv) && !fs.existsSync(files.validation)) {
      return candidate;
    }
    candidate = `${String(stamp || '').trim() || compactTimestamp()}-${String(suffix).padStart(2, '0')}`;
    suffix += 1;
  }
}

function validateUsersBackupPayload(payload, options = {}) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const users = Array.isArray(src.users) ? src.users : [];
  const fileCounts = summarizeUsers(users);
  const expectedCounts = options.expectedCounts && typeof options.expectedCounts === 'object' ? options.expectedCounts : null;
  const errors = [];

  if (src.schemaVersion !== 1) {
    errors.push(`Unsupported schemaVersion: ${String(src.schemaVersion || '') || '(missing)'}`);
  }
  if (String(src.source || '').trim() !== 'postgres.users') {
    errors.push(`Unexpected backup source: ${String(src.source || '') || '(missing)'}`);
  }
  if (fileCounts.total !== users.length) {
    errors.push(`User count mismatch inside backup: users=${users.length} summary=${fileCounts.total}`);
  }
  if (expectedCounts) {
    const keys = Object.keys(expectedCounts).sort();
    keys.forEach((key) => {
      const expected = Number(expectedCounts[key]) || 0;
      const actual = Number(fileCounts[key]) || 0;
      if (expected !== actual) {
        errors.push(`Count mismatch for ${key}: expected=${expected} actual=${actual}`);
      }
    });
  }

  return {
    ok: errors.length === 0,
    validatedAt: new Date().toISOString(),
    schemaVersion: src.schemaVersion,
    source: src.source,
    exportedAt: String(src.exportedAt || '').trim(),
    fileCounts,
    expectedCounts: expectedCounts || null,
    includes: {
      active: fileCounts.active > 0,
      inactive: fileCounts.inactive > 0,
      deleted: fileCounts.deleted > 0,
    },
    errors,
  };
}

function validateUsersBackupFile(filePath, options = {}) {
  const payload = loadUsersBackupFile(filePath);
  const validation = validateUsersBackupPayload(payload, options);
  const connectionInfo = databaseConnectionInfo();
  return {
    ok: validation.ok,
    validatedAt: validation.validatedAt,
    backup: {
      schemaVersion: validation.schemaVersion,
      source: validation.source,
      exportedAt: validation.exportedAt,
      file: fileInfo(filePath),
    },
    csvFile: options.csvPath && fs.existsSync(options.csvPath) ? fileInfo(options.csvPath) : null,
    counts: validation.fileCounts,
    expectedCounts: validation.expectedCounts,
    includes: validation.includes,
    database: {
      host: connectionInfo.host,
      ssl: connectionInfo.ssl,
      nodeEnv: connectionInfo.nodeEnv,
    },
    errors: validation.errors,
  };
}

function pruneBackupSets(outDir, prefix, keep = backupRetentionCount()) {
  const dir = path.resolve(outDir);
  if (!fs.existsSync(dir)) return [];
  const matcher = new RegExp(`^${escapeRegex(prefix)}-(\\d{8}T\\d{6}(?:\\d{3})?Z(?:-\\d+)?)(?:\\.|$)`);
  const grouped = new Map();
  fs.readdirSync(dir).forEach((name) => {
    const match = name.match(matcher);
    if (!match) return;
    const stamp = match[1];
    if (!grouped.has(stamp)) grouped.set(stamp, []);
    grouped.get(stamp).push(path.join(dir, name));
  });
  const ordered = Array.from(grouped.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  const toDelete = ordered.slice(Math.max(keep, 0));
  const removed = [];
  toDelete.forEach(([, files]) => {
    files.forEach((filePath) => {
      if (!fs.existsSync(filePath)) return;
      fs.unlinkSync(filePath);
      removed.push(filePath);
    });
  });
  return removed;
}

function listValidatedBackupSets(baseDir = path.join(process.cwd(), 'backups', 'users')) {
  const root = path.resolve(baseDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const visit = (dirPath) => {
    fs.readdirSync(dirPath, { withFileTypes: true }).forEach((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith('.validation.json')) return;
      try {
        const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        out.push({
          validationPath: fullPath,
          exportedAt: String((payload.backup && payload.backup.exportedAt) || '').trim(),
          validatedAt: String(payload.validatedAt || '').trim(),
          jsonPath: payload.backup && payload.backup.file ? payload.backup.file.path : '',
          csvPath: payload.csvFile && payload.csvFile.path ? payload.csvFile.path : '',
          sizeBytes: payload.backup && payload.backup.file ? Number(payload.backup.file.sizeBytes) || 0 : 0,
          counts: payload.counts || {},
        });
      } catch {}
    });
  };
  visit(root);
  return out.sort((a, b) => String(b.validatedAt || b.exportedAt).localeCompare(String(a.validatedAt || a.exportedAt)));
}

function latestValidatedBackup(baseDir = path.join(process.cwd(), 'backups', 'users')) {
  const list = listValidatedBackupSets(baseDir);
  return list[0] || null;
}

function writeLatestBackupStatus(entry, baseDir = path.join(process.cwd(), 'backups', 'users')) {
  const statusPath = backupStatusFilePath(baseDir);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return statusPath;
}

function syncLatestBackupStatusFromExisting(baseDir = path.join(process.cwd(), 'backups', 'users')) {
  const latest = latestValidatedBackup(baseDir);
  if (!latest) {
    return writeLatestBackupStatus(
      {
        ok: false,
        updatedAt: new Date().toISOString(),
        latestBackup: null,
        prunedFiles: [],
        warning: 'No validated user backup was found under this directory.',
      },
      baseDir,
    );
  }
  return writeLatestBackupStatus(
    {
      ok: true,
      updatedAt: String(latest.validatedAt || latest.exportedAt || '').trim() || new Date().toISOString(),
      latestBackup: {
        exportedAt: latest.exportedAt,
        validatedAt: latest.validatedAt,
        files: {
          json: latest.jsonPath,
          csv: latest.csvPath,
          validation: latest.validationPath,
        },
        counts: latest.counts || {},
      },
      prunedFiles: [],
    },
    baseDir,
  );
}

async function createValidatedUsersBackup(pool, options = {}) {
  if (String(process.env.APP_FORCE_BACKUP_FAILURE || '').trim() === '1') {
    throw new Error('Forced backup failure via APP_FORCE_BACKUP_FAILURE=1');
  }
  const outDir = path.resolve(options.outDir || path.join(process.cwd(), 'backups', 'users'));
  const prefix = String(options.prefix || 'users-export').trim() || 'users-export';
  const requestedStamp = String(options.stamp || compactTimestamp()).trim() || compactTimestamp();
  const keep = Math.max(1, Number.parseInt(String(options.keep || backupRetentionCount()), 10) || backupRetentionCount());
  fs.mkdirSync(outDir, { recursive: true });

  const snapshot = await buildUsersBackupSnapshot(pool, options);
  const stamp = ensureUniqueStamp(outDir, prefix, requestedStamp, { dataLabel: options.dataLabel });
  const files = resolveBackupFilePaths(outDir, prefix, stamp, { dataLabel: options.dataLabel });
  fs.writeFileSync(files.json, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  fs.writeFileSync(files.csv, `${usersBackupToCsv(snapshot)}\n`, 'utf8');

  const validation = validateUsersBackupFile(files.json, {
    expectedCounts: snapshot.counts,
    csvPath: files.csv,
  });
  fs.writeFileSync(files.validation, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  const prunedFiles = pruneBackupSets(outDir, prefix, keep);
  const status = {
    ok: validation.ok,
    updatedAt: validation.validatedAt,
    latestBackup: {
      exportedAt: snapshot.exportedAt,
      validatedAt: validation.validatedAt,
      files,
      counts: snapshot.counts,
    },
    prunedFiles,
  };
  const statusFile = writeLatestBackupStatus(status, outDir);

  return {
    ok: validation.ok,
    snapshot,
    validation,
    files,
    prunedFiles,
    statusFile,
  };
}

module.exports = {
  backupStatusFilePath,
  backupRetentionCount,
  compactTimestamp,
  createValidatedUsersBackup,
  latestValidatedBackup,
  listValidatedBackupSets,
  pruneBackupSets,
  resolveBackupFilePaths,
  syncLatestBackupStatusFromExisting,
  validateUsersBackupFile,
  validateUsersBackupPayload,
};

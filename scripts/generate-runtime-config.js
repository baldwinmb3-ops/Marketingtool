const fs = require('fs');
const path = require('path');

function ensureUrl(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch (error) {
    console.warn('Invalid URL provided, falling back', value, error);
    return fallback;
  }
}

function resolveClientVersion() {
  const override = String(process.env.APP_VERSION || '').trim();
  if (override) {
    return override;
  }
  return `build-${Date.now()}`;
}

function createVersionManifestContent(clientVersion) {
  return JSON.stringify(
    {
      ok: true,
      version: clientVersion,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n';
}

async function createConfigContent() {
  const defaultApiBase = 'https://marketingtool-backend-445z.onrender.com';
  const apiBaseUrl = ensureUrl(process.env.APP_API_BASE_URL, defaultApiBase);
  const versionManifestUrl = String(process.env.APP_VERSION_MANIFEST_URL || '').trim() || '/version.json';
  const clientVersion = resolveClientVersion();

  const config = {
    apiBaseUrl,
    remoteProjectUrl: '',
    remoteReadKey: '',
    remoteStateTable: 'pricing_catalog_state',
    remoteSyncFunction: 'dynamic-processor',
    remoteSyncEndpoint: '',
    versionManifestUrl,
    clientVersion,
    updateCheckIntervalMs: Number.parseInt(String(process.env.APP_VERSION_CHECK_INTERVAL_MS || '60000'), 10),
  };

  console.log(`runtime-config.js will use clientVersion=${config.clientVersion}`);
  return {
    runtimeConfig:
      `/* Runtime config (generated) */
window.__FlickerRuntimeConfig = Object.assign({}, window.__FlickerRuntimeConfig || {}, ${JSON.stringify(config, null, 2)});
`,
    versionManifest: createVersionManifestContent(clientVersion),
  };
}

async function writeRuntimeConfig() {
  const rootDir = path.join(__dirname, '..');
  const runtimeConfigPath = path.join(rootDir, 'runtime-config.js');
  const versionManifestPath = path.join(rootDir, 'version.json');
  const content = await createConfigContent();
  fs.writeFileSync(runtimeConfigPath, content.runtimeConfig, 'utf8');
  fs.writeFileSync(versionManifestPath, content.versionManifest, 'utf8');
  console.log('runtime-config.js generated (content written)');
  console.log('version.json generated (content written)');
}

writeRuntimeConfig().catch((error) => {
  console.error('Failed to generate runtime-config.js', error);
  process.exit(1);
});

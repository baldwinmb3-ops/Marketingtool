const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const outputDir = path.join(rootDir, 'public');
const vercelStaticDir = path.join(rootDir, '.vercel', 'output', 'static');

const filesToCopy = [
  'premium_pricing_clickable.html',
  'service-worker.js',
  'runtime-config.js',
  'version.json',
  'update-manager.js',
  'manifest.webmanifest',
  'logo.png',
];

function copyIntoDir(baseDir, relativePath) {
  const sourcePath = path.join(rootDir, relativePath);
  const destPath = path.join(baseDir, relativePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing build asset: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
}

function buildStaticOutput() {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  filesToCopy.forEach(relativePath => copyIntoDir(outputDir, relativePath));
  fs.mkdirSync(vercelStaticDir, { recursive: true });
  filesToCopy.forEach(relativePath => copyIntoDir(vercelStaticDir, relativePath));
  console.log(`public output generated with ${filesToCopy.length} files`);
  console.log(`.vercel/output/static refreshed with ${filesToCopy.length} files`);
}

buildStaticOutput();

#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionDomain, productionUrl, productionVersionUrl } from './deploy-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const deployCommandDisplay = 'npx vercel deploy --prebuilt --prod --yes';
const aliasCommandDisplay = `npx vercel alias set "<deployment-url>" ${productionDomain}`;
const verificationAttempts = 24;
const verificationDelayMs = 5000;

function resolveExecutable(name) {
  return name;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printBanner(title) {
  console.log(`\n=== ${title} ===`);
}

function printFailure(details) {
  const stageLabel = {
    auth: 'VERCEL AUTH',
    build: 'BUILD',
    deploy: 'DEPLOY',
    alias: 'ALIAS',
    verification: 'LIVE BUILD VERIFY',
  }[details.stage] || String(details.stage || 'UNKNOWN').toUpperCase();
  console.error(`\n=== HARD FAILURE: ${stageLabel} ===`);
  console.error(`Stage: ${details.stage}`);
  if (details.productionUrl) console.error(`Production URL: ${details.productionUrl}`);
  if (details.deploymentUrl) console.error(`Deployment URL: ${details.deploymentUrl}`);
  if (details.previousBuild) console.error(`Previous Build ID: ${details.previousBuild}`);
  if (details.expectedBuild) console.error(`Expected Build ID: ${details.expectedBuild}`);
  if (details.liveBuild) console.error(`Live Build ID: ${details.liveBuild}`);
  console.error(`Reason: ${details.reason}`);
  if (details.stage === 'auth') {
    console.error('Action: fix Vercel authentication first, then rerun npm run deploy:production.');
  }
  if (details.stage === 'alias') {
    console.error('Action: production alias did not move to the new deployment.');
  }
  if (details.stage === 'verification') {
    console.error('Action: production URL did not return the expected build marker.');
  }
  if (details.extra) {
    console.error(details.extra);
  }
  console.error('Result: FAILED');
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!text) return '""';
  if (!/[\s"&()^|<>]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

async function runCommand(command, args, options = {}) {
  const cwd = options.cwd || rootDir;
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quoteWindowsArg).join(' ')], {
          cwd,
          env: process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(command, args, {
          cwd,
          env: process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const combined = `${stdout}\n${stderr}`;
      if (code === 0) {
        resolve({ stdout, stderr, combined });
        return;
      }
      const error = new Error(`${command} ${args.join(' ')} exited with code ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      error.combined = combined;
      reject(error);
    });
  });
}

function looksLikeAuthFailure(text) {
  return /authentication token|not logged in|log in|login required|no existing credentials|unauthorized|forbidden/i.test(String(text || ''));
}

function classifyFailureStage(error, fallbackStage) {
  if (looksLikeAuthFailure(`${error?.message || ''}\n${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.combined || ''}`)) {
    return 'auth';
  }
  return fallbackStage;
}

function extractDeploymentUrl(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^Production:\s+(https:\/\/[^\s]+\.vercel\.app)\b/i);
    if (match) {
      return match[1];
    }
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^(https:\/\/[a-z0-9-]+\.vercel\.app)\/?$/i);
    if (match && !match[1].includes(productionDomain)) {
      return match[1];
    }
  }

  const matches = Array.from(output.matchAll(/https:\/\/[a-z0-9-]+\.vercel\.app/gi))
    .map((match) => match[0])
    .filter((url) => !url.includes(productionDomain));

  return matches.length ? matches[matches.length - 1] : '';
}

async function fetchVersionManifest(url) {
  const cacheBust = `t=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const targetUrl = `${url}${url.includes('?') ? '&' : '?'}${cacheBust}`;
  const response = await fetch(targetUrl, {
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  const data = await response.json();
  const version = String(data?.version || '').trim();
  if (!version) {
    throw new Error(`Missing version field from ${url}`);
  }

  return version;
}

function readExpectedBuildId() {
  const versionManifestPath = path.join(rootDir, 'version.json');
  const content = fs.readFileSync(versionManifestPath, 'utf8');
  const parsed = JSON.parse(content);
  const version = String(parsed?.version || '').trim();
  if (!version) {
    throw new Error('Local version.json is missing a version field after build.');
  }
  return version;
}

async function verifyProductionBuild(expectedBuild, previousBuild) {
  let lastObservedBuild = '';
  let lastError = '';

  for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
    try {
      const liveBuild = await fetchVersionManifest(productionVersionUrl);
      lastObservedBuild = liveBuild;
      console.log(`Verification attempt ${attempt}/${verificationAttempts}: production build is ${liveBuild}`);
      if (liveBuild === expectedBuild) {
        if (previousBuild && liveBuild === previousBuild) {
          throw new Error(`Production still reports the previous build ${previousBuild}`);
        }
        return liveBuild;
      }
      lastError = `Production still reports ${liveBuild}, expected ${expectedBuild}`;
    } catch (error) {
      lastError = error.message;
      console.warn(`Verification attempt ${attempt}/${verificationAttempts} failed: ${lastError}`);
    }

    if (attempt < verificationAttempts) {
      await sleep(verificationDelayMs);
    }
  }

  const error = new Error(lastError || 'Production verification exhausted all retries.');
  error.liveBuild = lastObservedBuild;
  throw error;
}

async function main() {
  printBanner('PRODUCTION DEPLOY');
  console.log(`Production URL: ${productionUrl}`);
  console.log(`Deploy Command: ${deployCommandDisplay}`);
  console.log(`Alias Command: ${aliasCommandDisplay}`);

  printBanner('BUILD');
  try {
    await runCommand(resolveExecutable('npm'), ['run', 'build']);
  } catch (error) {
    error.stage = classifyFailureStage(error, 'build');
    throw error;
  }
  const expectedBuild = readExpectedBuildId();
  console.log(`Expected Build ID: ${expectedBuild}`);

  let previousBuild = '';
  try {
    previousBuild = await fetchVersionManifest(productionVersionUrl);
    console.log(`Previous Production Build ID: ${previousBuild}`);
  } catch (error) {
    console.warn(`Could not read previous production build: ${error.message}`);
  }

  if (previousBuild && previousBuild === expectedBuild) {
    throw Object.assign(new Error(`Build step did not produce a new build ID. Production and local both report ${expectedBuild}.`), {
      stage: 'build',
      previousBuild,
      expectedBuild,
    });
  }

  printBanner('DEPLOY');
  let deployResult;
  try {
    deployResult = await runCommand(resolveExecutable('npx'), ['vercel', 'deploy', '--prebuilt', '--prod', '--yes']);
  } catch (error) {
    error.stage = classifyFailureStage(error, 'deploy');
    error.previousBuild = previousBuild;
    error.expectedBuild = expectedBuild;
    throw error;
  }
  const deploymentUrl = extractDeploymentUrl(deployResult.combined);
  if (!deploymentUrl) {
    throw Object.assign(new Error('Could not extract the final deployment URL from Vercel deploy output.'), {
      stage: 'deploy',
      previousBuild,
      expectedBuild,
    });
  }
  console.log(`Deployment URL: ${deploymentUrl}`);

  printBanner('ALIAS');
  try {
    await runCommand(resolveExecutable('npx'), ['vercel', 'alias', 'set', deploymentUrl, productionDomain]);
  } catch (error) {
    error.stage = classifyFailureStage(error, 'alias');
    error.deploymentUrl = deploymentUrl;
    error.previousBuild = previousBuild;
    error.expectedBuild = expectedBuild;
    throw error;
  }
  console.log(`Alias confirmed for ${productionDomain}`);

  printBanner('VERIFY PRODUCTION');
  let liveBuild;
  try {
    liveBuild = await verifyProductionBuild(expectedBuild, previousBuild);
  } catch (error) {
    error.stage = 'verification';
    error.deploymentUrl = deploymentUrl;
    error.previousBuild = previousBuild;
    error.expectedBuild = expectedBuild;
    throw error;
  }

  console.log('\n=== DEPLOY COMPLETE ===');
  console.log(`Production URL: ${productionUrl}`);
  console.log(`Deployment URL: ${deploymentUrl}`);
  console.log(`Previous Build ID: ${previousBuild || 'unknown'}`);
  console.log(`Live Build ID: ${liveBuild}`);
  console.log('Result: SUCCESS');
}

main().catch((error) => {
  printFailure({
    stage: error.stage || 'unknown',
    productionUrl,
    deploymentUrl: error.deploymentUrl,
    previousBuild: error.previousBuild,
    expectedBuild: error.expectedBuild,
    liveBuild: error.liveBuild,
    reason: error.message,
    extra: error.stderr || error.stdout || '',
  });
  process.exit(1);
});

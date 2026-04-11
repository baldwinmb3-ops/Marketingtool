import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

const ROOT = process.cwd();
const STORAGE_KEY = "premium_pricing_clickable_html_v2";
const BACKEND_PORT = 8795;
const HTML_PORT = 4175;
const TTL_MS = 61000;
const WAIT_SLACK_MS = 2500;
const APP_URL = `http://127.0.0.1:${HTML_PORT}/premium_pricing_clickable.html`;
const API_BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;

function log(message, extra = null) {
  if (extra) {
    console.log(`${message} ${JSON.stringify(extra)}`);
    return;
  }
  console.log(message);
}

function startNodeProcess(label, scriptPath, env = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(`[${label}:stdout] ${String(chunk)}`));
  child.stderr.on("data", (chunk) => output.push(`[${label}:stderr] ${String(chunk)}`));
  return { label, child, output };
}

async function stopProcess(proc) {
  if (!proc || !proc.child || proc.child.exitCode !== null) return;
  proc.child.kill();
  const start = Date.now();
  while (proc.child.exitCode === null && Date.now() - start < 5000) {
    await delay(100);
  }
  if (proc.child.exitCode === null) {
    proc.child.kill("SIGKILL");
  }
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.ok || res.status < 500) return true;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function createContext(label) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), `idle-signout-${label}-`));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
  });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    window.__signedInUiSeen = false;
    const mark = () => {
      if (document.querySelector('[data-action="signout"]')) {
        window.__signedInUiSeen = true;
      }
    };
    if (document.documentElement) {
      const observer = new MutationObserver(mark);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener("readystatechange", mark);
    window.addEventListener("DOMContentLoaded", mark);
    mark();
  });
  return { context, userDataDir };
}

async function destroyContext(handle) {
  if (!handle) return;
  try {
    await handle.context.close();
  } finally {
    await fs.rm(handle.userDataDir, { recursive: true, force: true });
  }
}

async function appPage(context) {
  const existing = context.pages()[0] || (await context.newPage());
  await existing.goto(APP_URL, { waitUntil: "domcontentloaded" });
  return existing;
}

async function readStoredState(page) {
  return page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }, STORAGE_KEY);
}

async function waitForStored(page, predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await readStoredState(page);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error("Timed out waiting for stored state");
}

async function signIn(page) {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.locator('[data-field="authLocalIdentifier"]').fill("ADMIN1001");
  await page.locator('[data-field="authLocalPassword"]').fill("Admin123A");
  await page.locator('[data-action="auth-local-signin"]').click();
  await page.waitForSelector('[data-action="signout"]', { state: "visible" });
  const state = await waitForStored(page, (stored) => !!(stored && stored.authSession && stored.authSession.isAuthenticated && stored.role));
  return state;
}

async function signedOutSnapshot(page) {
  await page.waitForSelector('[data-action="auth-local-signin"]', { state: "visible", timeout: 20000 });
  const state = await waitForStored(page, (stored) => !!stored && !!stored.authSession && stored.authSession.isAuthenticated === false && !stored.role);
  const signedInUiSeen = await page.evaluate(() => !!window.__signedInUiSeen);
  return { state, signedInUiSeen };
}

function observeApiRequests(page) {
  const requests = [];
  const handler = (request) => {
    if (request.url().includes("/api/")) {
      requests.push({
        method: request.method(),
        url: request.url(),
      });
    }
  };
  page.on("request", handler);
  return {
    requests,
    stop() {
      page.off("request", handler);
    },
  };
}

async function scenarioCloseReopenAfterExpiry() {
  const handle = await createContext("close-reopen");
  try {
    const page = await appPage(handle.context);
    await signIn(page);
    await page.close();
    await delay(TTL_MS + WAIT_SLACK_MS);

    const reopened = await handle.context.newPage();
    const apiCounter = observeApiRequests(reopened);
    await reopened.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await delay(1200);
    const { state, signedInUiSeen } = await signedOutSnapshot(reopened);
    apiCounter.stop();
    return {
      name: "close_reopen_after_expiry",
      pass: true,
      signedInUiSeen,
      apiRequestsAfterReopen: apiCounter.requests,
      statusMessage: state.authStatusMessage,
      role: state.role,
      isAuthenticated: state.authSession.isAuthenticated,
    };
  } finally {
    await destroyContext(handle);
  }
}

async function scenarioHiddenTabExpiry() {
  const handle = await createContext("hidden-tab");
  try {
    const page = await appPage(handle.context);
    await signIn(page);
    await page.evaluate(() => {
      window.__idleVisibilityState = "hidden";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => window.__idleVisibilityState || "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await delay(TTL_MS + WAIT_SLACK_MS);
    await page.evaluate(() => {
      window.__idleVisibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const { state } = await signedOutSnapshot(page);
    return {
      name: "hidden_tab_return",
      pass: true,
      statusMessage: state.authStatusMessage,
      visibilityOnReturn: await page.evaluate(() => document.visibilityState),
    };
  } finally {
    await destroyContext(handle);
  }
}

async function scenarioSleepWakeExpiry() {
  const handle = await createContext("sleep-wake");
  try {
    const page = await appPage(handle.context);
    await signIn(page);
    const cdp = await handle.context.newCDPSession(page);
    let mode = "page_frozen";
    try {
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      await delay(TTL_MS + WAIT_SLACK_MS);
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
    } catch {
      mode = "timer_fallback";
      await delay(TTL_MS + WAIT_SLACK_MS);
    }
    await page.bringToFront();
    const { state } = await signedOutSnapshot(page);
    return {
      name: "sleep_wake_after_expiry",
      pass: true,
      mode,
      statusMessage: state.authStatusMessage,
    };
  } finally {
    await destroyContext(handle);
  }
}

async function scenarioRefreshAfterExpiry() {
  const handle = await createContext("refresh-expiry");
  try {
    const page = await appPage(handle.context);
    await signIn(page);
    await delay(TTL_MS + WAIT_SLACK_MS);
    const apiCounter = observeApiRequests(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await delay(1200);
    const { state, signedInUiSeen } = await signedOutSnapshot(page);
    apiCounter.stop();
    return {
      name: "refresh_after_expiry",
      pass: true,
      signedInUiSeen,
      apiRequestsAfterRefresh: apiCounter.requests,
      statusMessage: state.authStatusMessage,
      isAuthenticated: state.authSession.isAuthenticated,
    };
  } finally {
    await destroyContext(handle);
  }
}

async function scenarioOfflineTimeoutLogout() {
  const handle = await createContext("offline-timeout");
  try {
    const page = await appPage(handle.context);
    await signIn(page);
    await handle.context.setOffline(true);
    await delay(TTL_MS + WAIT_SLACK_MS);
    const { state } = await signedOutSnapshot(page);
    await handle.context.setOffline(false);
    return {
      name: "offline_timeout_logout",
      pass: true,
      statusMessage: state.authStatusMessage,
      offlineLogoutWorked: state.authSession.isAuthenticated === false,
    };
  } finally {
    await destroyContext(handle);
  }
}

async function scenarioPollingRaceNoZombie() {
  const handle = await createContext("polling-race");
  try {
    const page = await appPage(handle.context);
    await signIn(page);
    await page.route("**/api/cloud", async (route) => {
      const request = route.request();
      const action = request.postData() || "";
      if (action.includes("auth_sign_in")) {
        await route.continue();
        return;
      }
      await delay(TTL_MS + WAIT_SLACK_MS + 1200);
      await route.continue();
    });
    await page.evaluate(() => triggerAutoCloudLoadNow({ promptOnFail: false, context: "race-test", retries: 0 }));
    await delay(TTL_MS + WAIT_SLACK_MS);
    const signedOut = await signedOutSnapshot(page);
    await delay(4000);
    const finalState = await readStoredState(page);
    return {
      name: "background_polling_race",
      pass: true,
      statusMessage: signedOut.state.authStatusMessage,
      finalIsAuthenticated: finalState.authSession.isAuthenticated,
      finalRole: finalState.role,
    };
  } finally {
    await destroyContext(handle);
  }
}

async function scenarioTwoTabsCrossSignout() {
  const handle = await createContext("two-tabs");
  try {
    const pageA = await appPage(handle.context);
    await signIn(pageA);
    const pageB = await handle.context.newPage();
    await pageB.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await pageB.waitForSelector('[data-action="signout"]', { state: "visible" });

    await delay(Math.floor(TTL_MS * 0.5));
    await pageB.bringToFront();
    await pageB.evaluate(() => authRecordActivity("cross-tab-test", { persistNow: true }));
    const pageBStateAfterActivity = await readStoredState(pageB);
    await pageA.bringToFront();
    await delay(Math.floor(TTL_MS * 0.52));

    const signedOutA = await signedOutSnapshot(pageA);
    await pageB.bringToFront();
    const signedOutB = await signedOutSnapshot(pageB);
    const stateB = signedOutB.state;
    const pageBIdleMs = Date.now() - Date.parse(pageBStateAfterActivity.authSession.lastActiveAt);
    return {
      name: "two_tabs_cross_signout",
      pass: true,
      pageAStatus: signedOutA.state.authStatusMessage,
      pageBStatus: stateB.authStatusMessage,
      pageBIdleMsAtCrossSignout: pageBIdleMs,
      pageBWouldStillBeWithinOwnTtl: pageBIdleMs < TTL_MS,
    };
  } finally {
    await destroyContext(handle);
  }
}

async function main() {
  const backend = startNodeProcess("backend", "server/index-memory.cjs", {
    API_PORT: String(BACKEND_PORT),
    APP_SESSION_TTL_MS: String(TTL_MS),
    APP_CORS_ORIGIN: `http://127.0.0.1:${HTML_PORT}`,
  });
  const html = startNodeProcess("html", "scripts/serve-html.mjs", {
    PORT: String(HTML_PORT),
    APP_API_BASE_URL: API_BASE_URL,
  });
  try {
    await waitForHttp(`${API_BASE_URL}/api/auth/session`);
    await waitForHttp(APP_URL);

    const results = [];
    for (const run of [
      scenarioCloseReopenAfterExpiry,
      scenarioHiddenTabExpiry,
      scenarioSleepWakeExpiry,
      scenarioRefreshAfterExpiry,
      scenarioOfflineTimeoutLogout,
      scenarioPollingRaceNoZombie,
      scenarioTwoTabsCrossSignout,
    ]) {
      const result = await run();
      results.push(result);
      log(`[idle-signout-test] ${result.name}`, result);
    }

    assert.equal(results.length, 7);
    assert.ok(results.every((result) => result.pass === true));
    const closeReopen = results.find((result) => result.name === "close_reopen_after_expiry");
    const refresh = results.find((result) => result.name === "refresh_after_expiry");
    const crossTab = results.find((result) => result.name === "two_tabs_cross_signout");
    assert.equal(closeReopen.isAuthenticated, false);
    assert.equal(refresh.isAuthenticated, false);
    assert.equal(Array.isArray(closeReopen.apiRequestsAfterReopen) ? closeReopen.apiRequestsAfterReopen.length : -1, 0);
    assert.equal(Array.isArray(refresh.apiRequestsAfterRefresh) ? refresh.apiRequestsAfterRefresh.length : -1, 0);
    assert.equal(crossTab.pageBWouldStillBeWithinOwnTtl, true);

    console.log(JSON.stringify({ ok: true, ttl_ms: TTL_MS, results }, null, 2));
  } finally {
    await stopProcess(html);
    await stopProcess(backend);
    if (backend.output.length) {
      await fs.writeFile(path.join(ROOT, "tmp-idle-signout-backend.log"), backend.output.join(""), "utf8");
    }
    if (html.output.length) {
      await fs.writeFile(path.join(ROOT, "tmp-idle-signout-html.log"), html.output.join(""), "utf8");
    }
  }
}

main().catch((error) => {
  console.error(String((error && error.stack) || error));
  process.exit(1);
});

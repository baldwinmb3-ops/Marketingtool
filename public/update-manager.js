(() => {
  const config = (window.__FlickerRuntimeConfig && typeof window.__FlickerRuntimeConfig === 'object')
    ? window.__FlickerRuntimeConfig
    : {};
  const clientVersion = String(config.clientVersion || '').trim();
  const manifestUrl = String(config.versionManifestUrl || '').trim();
  const updateIntervalMs = Math.max(0, Number(config.updateCheckIntervalMs || 60000));
  const isFileProtocol = window.location.protocol === 'file:';
  const overlay = document.getElementById('flicker-update-overlay');
  const titleEl = document.getElementById('flicker-update-title');
  const messageEl = document.getElementById('flicker-update-message');
  const actionButton = document.getElementById('flicker-update-action');
  const STORAGE_VERSION_KEY = 'flickerLastSuccessfulVersion';
  const STORAGE_RETRY_KEY = 'flickerVersionRetryCount';
  const STORAGE_COOLDOWN_KEY = 'flickerVersionRetryCooldown';
  const MAX_AUTO_RELOADS = 3;
  const RETRY_DELAY_MS = 1200;
  const COOLDOWN_MS = 120000;
  let checkInProgress = false;
  let retryTimer = null;
  let fallbackInterval = null;
  let appStarted = false;
  const safeStorage = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (error) {
        console.debug('Update manager storage read blocked', error);
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (error) {
        console.debug('Update manager storage write blocked', error);
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (error) {
        console.debug('Update manager storage remove blocked', error);
      }
    }
  };
  function setOverlay(visible, title, message, showButton = false, buttonLabel = 'Refresh to update') {
    if (!overlay) return;
    overlay.dataset.visible = visible ? 'true' : 'false';
    overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (titleEl && typeof title === 'string') {
      titleEl.textContent = title;
    }
    if (messageEl && typeof message === 'string') {
      messageEl.textContent = message;
    }
    if (actionButton) {
      actionButton.textContent = buttonLabel || 'Refresh to update';
      if (showButton) {
        actionButton.style.display = 'inline-flex';
        actionButton.onclick = handleManualReload;
      } else {
        actionButton.style.display = 'none';
        actionButton.onclick = null;
      }
    }
  }
  function clearRetryTimer() {
    if (retryTimer) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }
  function scheduleRetry(delay) {
    clearRetryTimer();
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      checkVersion();
    }, Math.max(0, delay));
  }
  function scheduleRetryAfterCooldown(until) {
    clearRetryTimer();
    const delay = Math.max(0, until - Date.now());
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      checkVersion();
    }, delay + 10);
  }
  function getCooldownUntil() {
    return Number(safeStorage.get(STORAGE_COOLDOWN_KEY)) || 0;
  }
  function incrementRetryCount() {
    const current = Number(safeStorage.get(STORAGE_RETRY_KEY)) || 0;
    const next = current + 1;
    safeStorage.set(STORAGE_RETRY_KEY, String(next));
    return next;
  }
  function resetRetryState() {
    safeStorage.remove(STORAGE_RETRY_KEY);
    safeStorage.remove(STORAGE_COOLDOWN_KEY);
  }
  function storeSuccessfulVersion(version) {
    safeStorage.set(STORAGE_VERSION_KEY, version);
  }
  function startCooldown() {
    const until = Date.now() + COOLDOWN_MS;
    safeStorage.set(STORAGE_COOLDOWN_KEY, String(until));
    scheduleRetryAfterCooldown(until);
    return until;
  }
  async function clearPageCaches() {
    try {
      if (window.caches && window.caches.keys) {
        const cacheNames = await window.caches.keys();
        await Promise.all(cacheNames.map((name) => window.caches.delete(name)));
      }
    } catch (error) {
      console.debug('Update manager failed to clear caches', error);
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      } catch (error) {
        console.debug('Update manager failed to unregister service workers', error);
      }
    }
  }
  async function reloadFresh() {
    setOverlay(true, 'Refreshing app…', 'Reloading the newest version…', false);
    await clearPageCaches();
    window.setTimeout(() => {
      window.location.reload();
    }, RETRY_DELAY_MS);
  }
  function startApp() {
    if (appStarted) return;
    appStarted = true;
    clearRetryTimer();
    setOverlay(false);
    const loader = window.__FlickerAppLoader;
    if (typeof loader === 'function') {
      loader();
    }
  }
  function handleManualReload() {
    resetRetryState();
    reloadFresh();
  }
  function handleVersionMismatch(serverVersion) {
    const attempts = incrementRetryCount();
    if (attempts >= MAX_AUTO_RELOADS) {
      const until = startCooldown();
      setOverlay(true, 'Update ready', `Version ${serverVersion} is available. Refresh to update.`, true);
      return;
    }
    setOverlay(true, 'Updating app…', `Reloading version ${serverVersion}…`, false);
    reloadFresh();
  }
  function handleManifestError(error) {
    console.debug('Update manager cannot reach version manifest', error);
    const message = (error && error.message) ? error.message : 'Unable to reach the version manifest.';
    const attempts = incrementRetryCount();
    if (attempts >= MAX_AUTO_RELOADS) {
      const until = startCooldown();
      const remainingSeconds = Math.ceil((until - Date.now()) / 1000);
      setOverlay(true, 'Update paused', `${message} Retrying in ${remainingSeconds} seconds.`, true);
      return;
    }
    setOverlay(true, 'Checking for updates…', `${message} Retrying shortly.`, false);
    scheduleRetry(RETRY_DELAY_MS);
  }
  async function checkVersion() {
    if (isFileProtocol) {
      startApp();
      return;
    }
    if (!manifestUrl || !clientVersion) {
      startApp();
      return;
    }
    if (checkInProgress) return;
    const cooldownUntil = getCooldownUntil();
    if (cooldownUntil > Date.now()) {
      const remainingSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
      setOverlay(true, 'Update paused', `Retrying in ${remainingSeconds} seconds.`, true);
      scheduleRetryAfterCooldown(cooldownUntil);
      return;
    }
    checkInProgress = true;
    try {
      const response = await fetch(manifestUrl, { cache: 'no-store', credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Version fetch failed: ${response.status}`);
      }
      const payload = await response.json();
      const serverVersion = String((payload && payload.version) || '').trim();
      if (!serverVersion) {
        throw new Error('Version manifest did not include a version.');
      }
      if (serverVersion !== clientVersion) {
        handleVersionMismatch(serverVersion);
        return;
      }
      storeSuccessfulVersion(serverVersion);
      resetRetryState();
      startApp();
    } catch (error) {
      handleManifestError(error);
    } finally {
      checkInProgress = false;
    }
  }
  if (overlay) {
    if (isFileProtocol) {
      setOverlay(true, 'Starting app…', 'Local file mode skips cloud update checks.', false);
    } else {
      setOverlay(true, 'Checking for updates…', 'Connecting to the cloud…', false);
    }
  }
  if (!isFileProtocol && manifestUrl && clientVersion) {
    checkVersion();
    if (updateIntervalMs > 0) {
      fallbackInterval = window.setInterval(checkVersion, updateIntervalMs);
    }
  } else {
    startApp();
  }
  window.__FlickerUpdateManager = {
    checkVersion,
    resetState: resetRetryState,
    startApp
  };
})();

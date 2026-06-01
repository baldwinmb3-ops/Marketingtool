const MAX_LATENCY_SAMPLES = 512;

function createEmptyRouteMetric() {
  return {
    requestCount: 0,
    statusCounts: {
      '2xx': 0,
      '3xx': 0,
      '4xx': 0,
      '5xx': 0,
    },
    explicitStatusCounts: {
      '401': 0,
      '409': 0,
      '429': 0,
      '5xx': 0,
    },
    responseBytes: {
      total: 0,
      max: 0,
      last: 0,
    },
    latencyMsSamples: [],
    lastStatusCode: 0,
    lastSeenAt: '',
  };
}

const state = {
  startedAt: new Date().toISOString(),
  routes: new Map(),
  session: {
    lookupCount: 0,
    rowUpdateCount: 0,
  },
};

function ensureRouteMetric(key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  if (!state.routes.has(normalizedKey)) {
    state.routes.set(normalizedKey, createEmptyRouteMetric());
  }
  return state.routes.get(normalizedKey);
}

function pushLatencySample(samples, value) {
  samples.push(value);
  if (samples.length > MAX_LATENCY_SAMPLES) {
    samples.shift();
  }
}

function classifyStatus(statusCode) {
  const code = Number.parseInt(String(statusCode || 0), 10) || 0;
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  if (code >= 200) return '2xx';
  return 'other';
}

function quantile(samples, fraction) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  const value = sorted[index];
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function recordRouteMetric(key, options = {}) {
  const metric = ensureRouteMetric(key);
  if (!metric) return;
  const statusCode = Number.parseInt(String(options.statusCode || 0), 10) || 0;
  const responseBytes = Math.max(0, Number.parseInt(String(options.responseBytes || 0), 10) || 0);
  const latencyMs = Number(options.latencyMs);

  metric.requestCount += 1;
  const statusClass = classifyStatus(statusCode);
  if (Object.prototype.hasOwnProperty.call(metric.statusCounts, statusClass)) {
    metric.statusCounts[statusClass] += 1;
  }
  if (statusCode === 401) metric.explicitStatusCounts['401'] += 1;
  if (statusCode === 409) metric.explicitStatusCounts['409'] += 1;
  if (statusCode === 429) metric.explicitStatusCounts['429'] += 1;
  if (statusCode >= 500) metric.explicitStatusCounts['5xx'] += 1;
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    pushLatencySample(metric.latencyMsSamples, Number(latencyMs.toFixed(3)));
  }
  metric.responseBytes.total += responseBytes;
  metric.responseBytes.last = responseBytes;
  metric.responseBytes.max = Math.max(metric.responseBytes.max, responseBytes);
  metric.lastStatusCode = statusCode;
  metric.lastSeenAt = new Date().toISOString();
}

function observeRoute(key, res) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey || !res || typeof res.once !== 'function') return;
  const startedAt = process.hrtime.bigint();
  let recorded = false;
  const finalize = () => {
    if (recorded) return;
    recorded = true;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const headerValue = typeof res.getHeader === 'function' ? res.getHeader('content-length') : 0;
    const responseBytes = Math.max(0, Number.parseInt(String(headerValue || 0), 10) || 0);
    recordRouteMetric(normalizedKey, {
      statusCode: res.statusCode,
      responseBytes,
      latencyMs: elapsedMs,
    });
  };
  res.once('finish', finalize);
  res.once('close', finalize);
}

function recordSessionLookup() {
  state.session.lookupCount += 1;
}

function recordSessionRowUpdate() {
  state.session.rowUpdateCount += 1;
}

function snapshotPilotReadinessDiagnostics() {
  const routes = {};
  for (const [key, metric] of state.routes.entries()) {
    routes[key] = {
      requestCount: metric.requestCount,
      statusCounts: { ...metric.statusCounts },
      explicitStatusCounts: { ...metric.explicitStatusCounts },
      responseBytes: {
        total: metric.responseBytes.total,
        max: metric.responseBytes.max,
        last: metric.responseBytes.last,
        average: metric.requestCount ? Number((metric.responseBytes.total / metric.requestCount).toFixed(2)) : 0,
      },
      latencyMs: {
        sampleCount: metric.latencyMsSamples.length,
        p50: quantile(metric.latencyMsSamples, 0.5),
        p95: quantile(metric.latencyMsSamples, 0.95),
        p99: quantile(metric.latencyMsSamples, 0.99),
      },
      lastStatusCode: metric.lastStatusCode,
      lastSeenAt: metric.lastSeenAt,
    };
  }

  return {
    startedAt: state.startedAt,
    generatedAt: new Date().toISOString(),
    session: {
      lookupCount: state.session.lookupCount,
      rowUpdateCount: state.session.rowUpdateCount,
    },
    routes,
  };
}

function resetPilotReadinessDiagnostics() {
  state.startedAt = new Date().toISOString();
  state.routes = new Map();
  state.session.lookupCount = 0;
  state.session.rowUpdateCount = 0;
}

module.exports = {
  observeRoute,
  recordSessionLookup,
  recordSessionRowUpdate,
  snapshotPilotReadinessDiagnostics,
  resetPilotReadinessDiagnostics,
};

export interface RemoteAlertsConfig {
  supabaseUrl: string;
  anonKey: string;
  adminKey: string;
  alertsTable: string;
  autoSync: boolean;
}

export interface RemoteAlertRow {
  brand_key: string;
  brand_id: string;
  brand_name: string;
  alert_active: boolean;
  alert_message: string;
  frequent_alert: boolean;
  sent_at: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface UpsertRemoteAlertPayload {
  brandId: string;
  brandName: string;
  alertActive: boolean;
  alertMessage: string;
  frequentAlert: boolean;
  sentAt: string;
  updatedAt: string;
  updatedBy: string;
}

const DEFAULT_ALERTS_TABLE = "show_alert_broadcasts";

function sanitizeUrl(value: string): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function sanitizeTableName(value: string): string {
  const safe = String(value || "").trim().replace(/[^a-zA-Z0-9_]/g, "");
  return safe || DEFAULT_ALERTS_TABLE;
}

function parseErrorMessage(raw: unknown, fallback: string): string {
  if (raw && typeof raw === "object") {
    const payload = raw as Record<string, unknown>;
    const fromPayload =
      payload.message ?? payload.error_description ?? payload.error ?? payload.details ?? payload.hint;
    if (typeof fromPayload === "string" && fromPayload.trim()) {
      return fromPayload.trim();
    }
  }

  return fallback;
}

function getReadHeaders(config: RemoteAlertsConfig): Record<string, string> {
  const key = String(config.anonKey || "").trim();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`
  };
}

function getWriteHeaders(config: RemoteAlertsConfig): Record<string, string> {
  const key = String(config.adminKey || "").trim();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=representation"
  };
}

async function requestJson(url: string, options: RequestInit): Promise<unknown> {
  const response = await fetch(url, options);
  const raw = await response.text();

  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }

  if (!response.ok) {
    throw new Error(parseErrorMessage(payload, raw || response.statusText || "Remote request failed."));
  }

  return payload;
}

export function normalizeBrandKey(brandName: string): string {
  return String(brandName || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeRemoteAlertsConfig(raw?: Partial<RemoteAlertsConfig> | null): RemoteAlertsConfig {
  const source = raw ?? {};
  return {
    supabaseUrl: sanitizeUrl(source.supabaseUrl ?? ""),
    anonKey: String(source.anonKey ?? "").trim(),
    adminKey: String(source.adminKey ?? "").trim(),
    alertsTable: sanitizeTableName(source.alertsTable ?? DEFAULT_ALERTS_TABLE),
    autoSync: typeof source.autoSync === "boolean" ? source.autoSync : true
  };
}

export function canReadRemoteAlerts(config: RemoteAlertsConfig): boolean {
  return !!(sanitizeUrl(config.supabaseUrl) && String(config.anonKey || "").trim());
}

export function canWriteRemoteAlerts(config: RemoteAlertsConfig): boolean {
  return !!(sanitizeUrl(config.supabaseUrl) && String(config.adminKey || "").trim());
}

export function readRemoteConfigError(config: RemoteAlertsConfig): string {
  if (!sanitizeUrl(config.supabaseUrl)) {
    return "Enter Supabase URL to sync alerts.";
  }
  if (!String(config.anonKey || "").trim()) {
    return "Enter Supabase Anon Key to read live alerts.";
  }
  return "";
}

export function readRemoteWriteConfigError(config: RemoteAlertsConfig): string {
  if (!sanitizeUrl(config.supabaseUrl)) {
    return "Enter Supabase URL before sending alerts.";
  }
  if (!String(config.adminKey || "").trim()) {
    return "Enter Supabase Admin Write Key before sending alerts.";
  }
  return "";
}

export async function fetchRemoteAlerts(config: RemoteAlertsConfig): Promise<RemoteAlertRow[]> {
  const readError = readRemoteConfigError(config);
  if (readError) {
    throw new Error(readError);
  }

  const safeConfig = normalizeRemoteAlertsConfig(config);
  const url =
    `${safeConfig.supabaseUrl}/rest/v1/${encodeURIComponent(safeConfig.alertsTable)}` +
    "?select=brand_key,brand_id,brand_name,alert_active,alert_message,frequent_alert,sent_at,updated_at,updated_by" +
    "&order=brand_name.asc";

  const payload = await requestJson(url, {
    method: "GET",
    headers: getReadHeaders(safeConfig)
  });

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload as RemoteAlertRow[];
}

export async function upsertRemoteAlert(
  config: RemoteAlertsConfig,
  alert: UpsertRemoteAlertPayload
): Promise<RemoteAlertRow | null> {
  const writeError = readRemoteWriteConfigError(config);
  if (writeError) {
    throw new Error(writeError);
  }

  const brandName = String(alert.brandName || "").trim();
  if (!brandName) {
    throw new Error("Brand name is required to send a remote alert.");
  }

  const safeConfig = normalizeRemoteAlertsConfig(config);
  const row: RemoteAlertRow = {
    brand_key: normalizeBrandKey(brandName),
    brand_id: String(alert.brandId || "").trim(),
    brand_name: brandName,
    alert_active: !!alert.alertActive,
    alert_message: String(alert.alertMessage || "").trim(),
    frequent_alert: !!alert.frequentAlert,
    sent_at: alert.sentAt ? String(alert.sentAt) : null,
    updated_at: alert.updatedAt ? String(alert.updatedAt) : new Date().toISOString(),
    updated_by: alert.updatedBy ? String(alert.updatedBy) : "admin-react"
  };

  const url = `${safeConfig.supabaseUrl}/rest/v1/${encodeURIComponent(safeConfig.alertsTable)}?on_conflict=brand_key`;
  const payload = await requestJson(url, {
    method: "POST",
    headers: getWriteHeaders(safeConfig),
    body: JSON.stringify([row])
  });

  if (Array.isArray(payload) && payload.length) {
    return payload[0] as RemoteAlertRow;
  }

  return null;
}

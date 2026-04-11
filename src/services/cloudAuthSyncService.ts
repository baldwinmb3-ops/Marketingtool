export interface CloudSyncConfig {
  supabaseUrl: string;
  readKey: string;
  functionName?: string;
  stateTable?: string;
}

export type CloudRole = "primary_admin" | "assistant_admin" | "marketer";

export type UserMutation =
  | {
      op: "create_user";
      wwid: string;
      role: CloudRole;
      displayName: string;
      forcePasswordReset?: boolean;
      metadata?: Record<string, unknown>;
    }
  | {
      op: "update_user" | "set_user_status" | "delete_user";
      wwid: string;
      role?: CloudRole;
      status?: "active" | "inactive" | "deleted";
      metadata?: Record<string, unknown>;
    };

export interface SaveAndSendActor {
  userId?: string | null;
  name?: string;
  role?: string;
}

export interface CatalogPayload {
  meta?: Record<string, unknown>;
  brands: unknown[];
  ticketLines: unknown[];
  resources: unknown[];
}

export interface SaveAndSendResult {
  ok: boolean;
  requestId: string;
  message: string;
  version?: number;
  publishedAt?: string;
  accountReadiness: {
    pending: number;
    ready: number;
    failed: number;
  };
  details?: string;
}

const DEFAULT_FUNCTION = "dynamic-processor";
const DEFAULT_TABLE = "pricing_catalog_state";

function cleanUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function cleanTable(value: string | undefined) {
  const safe = String(value || DEFAULT_TABLE).trim().replace(/[^a-zA-Z0-9_]/g, "");
  return safe || DEFAULT_TABLE;
}

function normalizeWwid(input: string) {
  return String(input || "").replace(/\s+/g, "").trim().toUpperCase();
}

function normalizeMessage(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    const direct = row.message ?? row.error_description ?? row.error ?? row.details;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }
  return "";
}

function normalizeUserMutations(input: UserMutation[] | undefined) {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((row) => {
      const op = String((row as Record<string, unknown>).op || "").trim().toLowerCase();
      if (
        op !== "create_user" &&
        op !== "update_user" &&
        op !== "set_user_status" &&
        op !== "delete_user"
      ) {
        return null;
      }
      const wwid = normalizeWwid(String((row as Record<string, unknown>).wwid || ""));
      if (!wwid) return null;
      const role =
        row.role === "primary_admin" ||
        row.role === "assistant_admin" ||
        row.role === "marketer"
          ? row.role
          : undefined;
      const output: Record<string, unknown> = {
        op,
        wwid,
      };
      if (role) output.role = role;
      const displayName =
        "displayName" in row && typeof row.displayName === "string"
          ? row.displayName
          : "";
      if (displayName.trim()) {
        output.display_name = displayName.trim().slice(0, 120);
      }
      const forcePasswordReset =
        "forcePasswordReset" in row && typeof row.forcePasswordReset === "boolean"
          ? row.forcePasswordReset
          : undefined;
      if (typeof forcePasswordReset === "boolean") {
        output.force_password_reset = forcePasswordReset;
      }
      const status =
        "status" in row && typeof row.status === "string" ? row.status : "";
      if (status.trim()) {
        output.status = status;
      }
      if (row.metadata && typeof row.metadata === "object") {
        output.metadata = row.metadata;
      }
      return output;
    })
    .filter(Boolean) as Record<string, unknown>[];
}

function sanitizeCatalogPayload(payload: CatalogPayload): CatalogPayload {
  // Phase 1 guardrail: auth fields never ride inside catalog payloads.
  return {
    meta: payload?.meta && typeof payload.meta === "object" ? payload.meta : {},
    brands: Array.isArray(payload?.brands) ? payload.brands : [],
    ticketLines: Array.isArray(payload?.ticketLines) ? payload.ticketLines : [],
    resources: Array.isArray(payload?.resources) ? payload.resources : [],
  };
}

function safeAdminMessageFromBackend(
  backendMessage: string,
  readiness: { pending: number; ready: number; failed: number },
) {
  if (backendMessage) return backendMessage;
  if (readiness.pending > 0) {
    const suffix = readiness.pending === 1 ? "account is" : "accounts are";
    return `Cloud synced. ${readiness.pending} ${suffix} still being set up in the cloud.`;
  }
  return "Cloud synced.";
}

async function requestJson(url: string, options: RequestInit): Promise<unknown> {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload: unknown = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const message = normalizeMessage(payload) || text || response.statusText || "Cloud request failed.";
    throw new Error(message);
  }

  return payload;
}

export function createCloudAuthSyncService(config: CloudSyncConfig) {
  const baseUrl = cleanUrl(config.supabaseUrl);
  const readKey = String(config.readKey || "").trim();
  const functionName = String(config.functionName || DEFAULT_FUNCTION).trim() || DEFAULT_FUNCTION;
  const table = cleanTable(config.stateTable);
  const endpoint = `${baseUrl}/functions/v1/${encodeURIComponent(functionName)}`;

  return {
    isConfigured() {
      return !!(baseUrl && readKey);
    },

    getConfigurationError() {
      if (!baseUrl) return "Enter Supabase project URL first.";
      if (!readKey) return "Enter Supabase read key first.";
      return "";
    },

    async saveAndSend(input: {
      payload: CatalogPayload;
      actor?: SaveAndSendActor;
      requestId?: string;
      userMutations?: UserMutation[];
    }): Promise<SaveAndSendResult> {
      const configError = this.getConfigurationError();
      if (configError) {
        throw new Error(configError);
      }

      const actor = input.actor || {};
      const safePayload = sanitizeCatalogPayload(input.payload);
      const safeMutations = normalizeUserMutations(input.userMutations);
      const requestId = String(input.requestId || "").trim();

      const raw = await requestJson(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: readKey,
          Authorization: `Bearer ${readKey}`,
        },
        body: JSON.stringify({
          action: "save_and_send",
          request_id: requestId || undefined,
          table,
          payload: safePayload,
          user_operations: safeMutations,
          actor_name: String(actor.name || "").trim() || "Primary Admin",
          actor_user_id: actor.userId || null,
          actor_role: String(actor.role || "").trim() || "primary_admin",
        }),
      });

      const result = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const readinessRaw =
        result.account_readiness && typeof result.account_readiness === "object"
          ? (result.account_readiness as Record<string, unknown>)
          : {};
      const readiness = {
        pending: Number(readinessRaw.pending ?? 0) || 0,
        ready: Number(readinessRaw.ready ?? 0) || 0,
        failed: Number(readinessRaw.failed ?? 0) || 0,
      };
      const backendMessage = typeof result.message === "string" ? result.message.trim() : "";

      return {
        ok: !!result.ok,
        requestId: String(result.request_id || requestId || "").trim(),
        message: safeAdminMessageFromBackend(backendMessage, readiness),
        version: Number(result.version ?? 0) || undefined,
        publishedAt:
          typeof result.published_at === "string" ? String(result.published_at).trim() : undefined,
        accountReadiness: readiness,
        details: typeof result.details === "string" ? result.details : undefined,
      };
    },

    async scanMigrationConflicts(users: unknown[], actorUserId?: string | null) {
      const configError = this.getConfigurationError();
      if (configError) {
        throw new Error(configError);
      }

      const raw = await requestJson(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: readKey,
          Authorization: `Bearer ${readKey}`,
        },
        body: JSON.stringify({
          action: "scan_migration_conflicts",
          users: Array.isArray(users) ? users : [],
          actor_user_id: actorUserId || null,
          source_label: "local_export",
        }),
      });

      return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    },
  };
}

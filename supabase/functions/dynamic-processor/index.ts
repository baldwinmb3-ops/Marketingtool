import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonRecord = Record<string, unknown>;
type AppRole = "primary_admin" | "assistant_admin" | "marketer";
type SaveRunStatus = "started" | "succeeded" | "succeeded_with_pending_auth" | "failed";
type UiRole = "admin" | "marketer";

type AppUserRow = {
  user_id: string;
  wwid: string;
  wwid_normalized: string;
  login_email: string;
  role: AppRole;
  status: "active" | "inactive" | "deleted";
  force_password_reset: boolean;
  cloud_account_state: "pending" | "ready" | "failed";
  cloud_account_last_error: string;
  first_name: string;
  last_name: string;
  work_email: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type AuthProvisioningTaskRow = {
  id: number;
  request_id: string;
  task_key: string;
  task_type: "create_user" | "update_user" | "set_user_status" | "delete_user";
  target_user_id: string | null;
  target_wwid: string;
  target_role: AppRole | null;
  target_display_name: string;
  cloud_account_state: "pending" | "ready" | "failed";
  payload: JsonRecord;
  status: "pending" | "retrying" | "done";
  attempts: number;
  last_error: string;
  next_retry_at: string | null;
};

type RunActorMeta = {
  actorUserId: string | null;
  actorRole: string;
};

const PROVISIONING_BATCH_LIMIT = 25;
const PROVISIONING_RETRY_BASE_MINUTES = 2;
const PROVISIONING_RETRY_MAX_MINUTES = 60;

type UserOperation = {
  op: "create_user" | "update_user" | "set_user_status" | "delete_user";
  wwid: string;
  role?: AppRole;
  display_name?: string;
  status?: "active" | "inactive" | "deleted";
  force_password_reset?: boolean;
  metadata?: JsonRecord;
};

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function normalizeTableName(input: unknown) {
  const raw = String(input ?? "pricing_catalog_state").trim();
  const safe = raw.replace(/[^a-zA-Z0-9_]/g, "");
  return safe || "pricing_catalog_state";
}

function normalizeText(input: unknown, maxLen = 200) {
  return String(input ?? "").trim().slice(0, maxLen);
}

function resolveClientApiKey(providedKey: string, serviceRoleKey: string) {
  const direct = normalizeText(providedKey, 500);
  if (direct) return direct;
  const anon = normalizeText(Deno.env.get("SUPABASE_ANON_KEY") ?? "", 500);
  if (anon) return anon;
  const publishable = normalizeText(Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "", 500);
  if (publishable) return publishable;
  const legacyAnon = normalizeText(Deno.env.get("SUPABASE_LEGACY_ANON_KEY") ?? "", 500);
  if (legacyAnon) return legacyAnon;
  return normalizeText(serviceRoleKey, 500);
}

function normalizeWwid(input: unknown) {
  return String(input ?? "").replace(/\s+/g, "").trim().toUpperCase();
}

function normalizeRole(input: unknown): AppRole | null {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "primary_admin" || value === "primary-admin" || value === "admin") {
    return "primary_admin";
  }
  if (value === "assistant_admin" || value === "assistant-admin" || value === "assistant") {
    return "assistant_admin";
  }
  if (value === "marketer") {
    return "marketer";
  }
  return null;
}

function normalizeUserStatus(input: unknown) {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "inactive") return "inactive";
  if (value === "deleted") return "deleted";
  return "active";
}

function normalizeUiRole(input: unknown): UiRole {
  const value = String(input ?? "").trim().toLowerCase();
  return value === "admin" ? "admin" : "marketer";
}

function normalizeEmail(input: unknown, maxLen = 320) {
  return String(input ?? "").trim().toLowerCase().slice(0, maxLen);
}

function normalizeIdentifier(input: unknown, maxLen = 320) {
  return String(input ?? "").trim().slice(0, maxLen);
}

function normalizePasswordInput(input: unknown, maxLen = 512) {
  return String(input ?? "").slice(0, maxLen);
}

function normalizeBoolean(input: unknown, fallback = false) {
  if (typeof input === "boolean") return input;
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return fallback;
}

function asJsonRecord(input: unknown): JsonRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as JsonRecord;
}

function isStrongPassword(input: unknown) {
  const value = String(input ?? "");
  return value.length >= 6 && /[A-Z]/.test(value) && /\d/.test(value);
}

function isUuid(value: string) {
  return UUID_REGEX.test(value);
}

function safeActorUserId(input: unknown) {
  const value = normalizeText(input, 64).toLowerCase();
  return isUuid(value) ? value : null;
}

async function sha256(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeCatalogPayload(input: unknown) {
  const src = (input && typeof input === "object" ? input : {}) as JsonRecord;
  const meta = (src.meta && typeof src.meta === "object"
    ? src.meta
    : {}) as JsonRecord;
  const brands = Array.isArray(src.brands) ? src.brands : [];
  const ticketLines = Array.isArray(src.ticketLines) ? src.ticketLines : [];
  const resources = Array.isArray(src.resources) ? src.resources : [];

  // Phase 1 guardrail: catalog payload must stay auth-free.
  return { meta, brands, ticketLines, resources };
}

function normalizeUserOperations(input: unknown) {
  const rows = Array.isArray(input) ? input : [];
  const output: UserOperation[] = [];

  for (const row of rows) {
    const src = (row && typeof row === "object" ? row : {}) as JsonRecord;
    const opRaw = normalizeText(src.op, 40).toLowerCase();
    const op =
      opRaw === "create_user" ||
      opRaw === "update_user" ||
      opRaw === "set_user_status" ||
      opRaw === "delete_user"
        ? opRaw
        : null;
    if (!op) continue;

    const wwid = normalizeWwid(src.wwid);
    if (!wwid) continue;

    const role = normalizeRole(src.role) ?? undefined;
    const displayName = normalizeText(src.display_name, 120) || undefined;
    const status = normalizeUserStatus(src.status);
    const forcePasswordReset =
      typeof src.force_password_reset === "boolean"
        ? src.force_password_reset
        : true;
    const metadata =
      src.metadata && typeof src.metadata === "object"
        ? (src.metadata as JsonRecord)
        : {};

    output.push({
      op,
      wwid,
      role,
      display_name: displayName,
      status,
      force_password_reset: forcePasswordReset,
      metadata,
    });
  }

  return output;
}

function internalSyntheticLoginEmail(wwid: string) {
  // Internal-only implementation detail for Auth compatibility.
  return `${normalizeWwid(wwid).toLowerCase()}@wwid.internal.local`;
}

function safeAdminMessage(status: SaveRunStatus, pendingCount: number) {
  if (status === "succeeded_with_pending_auth" && pendingCount > 0) {
    const suffix = pendingCount === 1 ? "account" : "accounts";
    return `Cloud synced. ${pendingCount} ${suffix} still setting up in the cloud.`;
  }
  if (status === "succeeded") {
    return "Cloud synced.";
  }
  if (status === "failed") {
    return "Cloud sync could not finish. Please try Save and Send again.";
  }
  return "Cloud sync is in progress.";
}

function appRoleMatchesUiRole(appRole: AppRole, uiRole: UiRole) {
  if (uiRole === "admin") {
    return appRole === "primary_admin" || appRole === "assistant_admin";
  }
  return appRole === "marketer";
}

function appRoleToUiRole(appRole: AppRole): UiRole {
  return appRole === "marketer" ? "marketer" : "admin";
}

function normalizeTaskType(input: unknown) {
  const value = String(input ?? "").trim().toLowerCase();
  if (
    value === "create_user" ||
    value === "update_user" ||
    value === "set_user_status" ||
    value === "delete_user"
  ) {
    return value;
  }
  return null;
}

function provisioningRetryAtIso(attempt: number) {
  const minutes = Math.min(
    PROVISIONING_RETRY_MAX_MINUTES,
    Math.max(PROVISIONING_RETRY_BASE_MINUTES, attempt * PROVISIONING_RETRY_BASE_MINUTES),
  );
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function publicUserProfile(row: AppUserRow) {
  const firstName = normalizeText(row.first_name, 120);
  const lastName = normalizeText(row.last_name, 120);
  const displayName =
    normalizeText(`${firstName} ${lastName}`, 120) ||
    normalizeText(row.work_email ?? "", 120) ||
    normalizeText(row.wwid, 120) ||
    "User";
  return {
    user_id: row.user_id,
    role: appRoleToUiRole(row.role),
    app_role: row.role,
    status: row.status,
    force_password_reset: !!row.force_password_reset,
    first_name: firstName,
    last_name: lastName,
    display_name: displayName,
    work_email: normalizeEmail(row.work_email ?? "", 320),
    phone: normalizeText(row.phone ?? "", 40),
    wwid: normalizeWwid(row.wwid),
    cloud_account_state: row.cloud_account_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function upsertSaveRunStart(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
  actorUserId: string | null,
  actorRole: string,
  requestHash: string,
) {
  const { error } = await supabase.from("save_send_runs").upsert(
    {
      request_id: requestId,
      actor_user_id: actorUserId,
      actor_role: actorRole || "primary_admin",
      request_hash: requestHash,
      status: "started",
      catalog_applied: false,
      user_ops_applied: false,
      auth_tasks_pending: 0,
      error_message: "",
      result_payload: {},
    },
    { onConflict: "request_id" },
  );
  if (error) throw new Error(error.message);
}

async function finalizeSaveRun(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
  status: SaveRunStatus,
  catalogApplied: boolean,
  userOpsApplied: boolean,
  authTasksPending: number,
  resultPayload: JsonRecord,
  errorMessage = "",
) {
  const { error } = await supabase
    .from("save_send_runs")
    .update({
      status,
      catalog_applied: catalogApplied,
      user_ops_applied: userOpsApplied,
      auth_tasks_pending: authTasksPending,
      error_message: errorMessage,
      result_payload: resultPayload,
    })
    .eq("request_id", requestId);
  if (error) throw new Error(error.message);
}

async function upsertCatalogStages(
  supabase: ReturnType<typeof createClient>,
  table: string,
  payload: JsonRecord,
  actorName: string,
) {
  const nowIso = new Date().toISOString();
  const meta = (payload.meta && typeof payload.meta === "object"
    ? payload.meta
    : {}) as JsonRecord;
  const prior = await supabase
    .from(table)
    .select("payload")
    .eq("stage", "published")
    .maybeSingle();
  if (prior.error) throw new Error(prior.error.message);

  const priorVersion = Number(
    ((prior.data?.payload as JsonRecord | null)?.meta as JsonRecord | null)
      ?.version ?? 0,
  );
  const nextVersion = Math.max(1, Number.isFinite(priorVersion) ? priorVersion + 1 : 1);

  const draftPayload = {
    ...payload,
    meta: { ...meta, updatedAt: nowIso, source: "save_and_send" },
  };
  const publishedPayload = {
    ...payload,
    meta: {
      ...meta,
      updatedAt: nowIso,
      publishedAt: nowIso,
      source: "save_and_send",
      version: nextVersion,
    },
  };

  const rows = [
    { stage: "draft", payload: draftPayload, updated_by: actorName || "save_and_send" },
    {
      stage: "published",
      payload: publishedPayload,
      updated_by: actorName || "save_and_send",
    },
  ];

  const { error } = await supabase.from(table).upsert(rows, { onConflict: "stage" });
  if (error) throw new Error(error.message);

  return { publishedAt: nowIso, version: nextVersion };
}

async function queueUserProvisioningTasks(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
  userOps: UserOperation[],
) {
  if (!userOps.length) {
    return { pendingAccountCount: 0, queuedOpsCount: 0 };
  }

  let pendingAccountCount = 0;
  let queuedOpsCount = 0;

  for (const op of userOps) {
    const role = op.role ?? (op.op === "create_user" ? "marketer" : undefined);
    const taskKey = `${op.op}:${op.wwid}`;
    const isCreate = op.op === "create_user";
    const payload = {
      operation: op.op,
      wwid: op.wwid,
      role,
      status: op.status ?? null,
      force_password_reset: op.force_password_reset !== false,
      metadata: op.metadata ?? {},
      ...(isCreate
        ? {
            // Internal implementation detail. Never surface to normal users.
            login_email: internalSyntheticLoginEmail(op.wwid),
          }
        : {}),
    };

    const { error } = await supabase.from("auth_provisioning_tasks").upsert(
      {
        request_id: requestId,
        task_key: taskKey,
        task_type: op.op,
        target_wwid: op.wwid,
        target_role: role ?? null,
        target_display_name: op.display_name ?? "",
        cloud_account_state: isCreate ? "pending" : "ready",
        payload,
        status: "pending",
        attempts: 0,
        last_error: "",
      },
      { onConflict: "task_key" },
    );
    if (error) throw new Error(error.message);
    queuedOpsCount += 1;
    if (isCreate) pendingAccountCount += 1;
  }

  return { pendingAccountCount, queuedOpsCount };
}

async function readAppUserByWwid(
  supabase: ReturnType<typeof createClient>,
  wwid: string,
) {
  const normalizedWwid = normalizeWwid(wwid);
  if (!normalizedWwid) return null;
  const { data, error } = await supabase
    .from("app_users")
    .select(
      "user_id,wwid,wwid_normalized,login_email,role,status,force_password_reset,cloud_account_state,cloud_account_last_error,first_name,last_name,work_email,phone,created_at,updated_at,deleted_at",
    )
    .eq("wwid_normalized", normalizedWwid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AppUserRow | null) ?? null;
}

async function readAppUserByIdentifier(
  supabase: ReturnType<typeof createClient>,
  identifier: string,
  requestedRole: UiRole,
) {
  const key = normalizeIdentifier(identifier, 320);
  if (!key) return null;
  const wwidKey = normalizeWwid(key);
  const emailKey = normalizeEmail(key, 320);

  const candidateKeys: Array<{ column: "wwid_normalized" | "work_email" | "login_email"; value: string }> = [];
  if (wwidKey) candidateKeys.push({ column: "wwid_normalized", value: wwidKey });
  if (emailKey) {
    candidateKeys.push({ column: "work_email", value: emailKey });
    candidateKeys.push({ column: "login_email", value: emailKey });
  }

  const seen = new Set<string>();
  const matches: AppUserRow[] = [];
  for (const candidate of candidateKeys) {
    const { data, error } = await supabase
      .from("app_users")
      .select(
        "user_id,wwid,wwid_normalized,login_email,role,status,force_password_reset,cloud_account_state,cloud_account_last_error,first_name,last_name,work_email,phone,created_at,updated_at,deleted_at",
      )
      .eq(candidate.column, candidate.value)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) continue;
    const row = data as AppUserRow;
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    matches.push(row);
  }

  return (
    matches.find((row) => appRoleMatchesUiRole(row.role, requestedRole)) ||
    null
  );
}

async function readPendingTaskForWwid(
  supabase: ReturnType<typeof createClient>,
  wwid: string,
) {
  const normalizedWwid = normalizeWwid(wwid);
  if (!normalizedWwid) return null;
  const { data, error } = await supabase
    .from("auth_provisioning_tasks")
    .select("id,status,last_error,target_wwid,target_role")
    .eq("target_wwid", normalizedWwid)
    .in("status", ["pending", "retrying"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function listRunnableProvisioningTasks(
  supabase: ReturnType<typeof createClient>,
  limit: number,
) {
  const take = Math.max(1, Math.min(100, Math.trunc(limit) || PROVISIONING_BATCH_LIMIT));
  const { data, error } = await supabase
    .from("auth_provisioning_tasks")
    .select(
      "id,request_id,task_key,task_type,target_user_id,target_wwid,target_role,target_display_name,cloud_account_state,payload,status,attempts,last_error,next_retry_at",
    )
    .in("status", ["pending", "retrying"])
    .order("created_at", { ascending: true })
    .limit(take * 3);
  if (error) throw new Error(error.message);
  const nowMs = Date.now();
  const list = (Array.isArray(data) ? data : []) as AuthProvisioningTaskRow[];
  return list
    .filter((task) => {
      const nextRetry = String(task.next_retry_at ?? "").trim();
      if (!nextRetry) return true;
      const retryMs = new Date(nextRetry).getTime();
      return Number.isFinite(retryMs) ? retryMs <= nowMs : true;
    })
    .slice(0, take);
}

async function countPendingTasksForRequest(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
) {
  const reqId = normalizeText(requestId, 64).toLowerCase();
  if (!isUuid(reqId)) return 0;
  const { count, error } = await supabase
    .from("auth_provisioning_tasks")
    .select("id", { count: "exact", head: true })
    .eq("request_id", reqId)
    .in("status", ["pending", "retrying"]);
  if (error) throw new Error(error.message);
  return Number(count ?? 0) || 0;
}

async function refreshSaveRunPendingCount(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
) {
  const reqId = normalizeText(requestId, 64).toLowerCase();
  if (!isUuid(reqId)) return;
  const existing = await supabase
    .from("save_send_runs")
    .select("status")
    .eq("request_id", reqId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const existingStatus = normalizeText(existing.data?.status ?? "", 64);
  if (existingStatus === "started" || existingStatus === "failed") {
    return;
  }
  const pending = await countPendingTasksForRequest(supabase, reqId);
  const status: SaveRunStatus = pending > 0 ? "succeeded_with_pending_auth" : "succeeded";
  const { error } = await supabase
    .from("save_send_runs")
    .update({
      auth_tasks_pending: pending,
      status,
    })
    .eq("request_id", reqId)
    .neq("status", "failed");
  if (error) throw new Error(error.message);
}

async function readRunActorMeta(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
  cache: Map<string, RunActorMeta>,
) {
  const reqId = normalizeText(requestId, 64).toLowerCase();
  if (!isUuid(reqId)) {
    return { actorUserId: null, actorRole: "" };
  }
  if (cache.has(reqId)) {
    return cache.get(reqId)!;
  }
  const { data, error } = await supabase
    .from("save_send_runs")
    .select("actor_user_id,actor_role")
    .eq("request_id", reqId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const actorUserId = safeActorUserId(data?.actor_user_id ?? null);
  const actorRole = normalizeText(data?.actor_role ?? "", 64);
  const meta = { actorUserId, actorRole };
  cache.set(reqId, meta);
  return meta;
}

async function writeUserAuditLog(
  supabase: ReturnType<typeof createClient>,
  input: {
    requestId: string;
    actorUserId: string | null;
    actorRole: string;
    action: string;
    targetUserId: string | null;
    beforeState: JsonRecord;
    afterState: JsonRecord;
    reason: string;
  },
) {
  const requestId = normalizeText(input.requestId, 64).toLowerCase();
  if (!isUuid(requestId)) return;
  const { error } = await supabase.from("app_user_audit_log").insert({
    request_id: requestId,
    actor_user_id: safeActorUserId(input.actorUserId),
    actor_role: normalizeText(input.actorRole, 64),
    action: normalizeText(input.action, 80),
    target_user_id: safeActorUserId(input.targetUserId),
    before_state: asJsonRecord(input.beforeState),
    after_state: asJsonRecord(input.afterState),
    reason: normalizeText(input.reason, 500),
  });
  if (error) throw new Error(error.message);
}

async function updateTaskSuccess(
  supabase: ReturnType<typeof createClient>,
  task: AuthProvisioningTaskRow,
  targetUserId: string | null,
) {
  const nextAttempts = Math.max(0, Number(task.attempts ?? 0)) + 1;
  const { error } = await supabase
    .from("auth_provisioning_tasks")
    .update({
      status: "done",
      attempts: nextAttempts,
      last_error: "",
      next_retry_at: null,
      target_user_id: safeActorUserId(targetUserId),
      cloud_account_state: "ready",
    })
    .eq("id", task.id);
  if (error) throw new Error(error.message);
}

async function updateTaskFailure(
  supabase: ReturnType<typeof createClient>,
  task: AuthProvisioningTaskRow,
  errorMessage: string,
) {
  const nextAttempts = Math.max(0, Number(task.attempts ?? 0)) + 1;
  const { error } = await supabase
    .from("auth_provisioning_tasks")
    .update({
      status: "retrying",
      attempts: nextAttempts,
      last_error: normalizeText(errorMessage, 500),
      next_retry_at: provisioningRetryAtIso(nextAttempts),
      cloud_account_state: "failed",
    })
    .eq("id", task.id);
  if (error) throw new Error(error.message);
}

function buildFallbackTempPassword(wwid: string) {
  const suffix = normalizeWwid(wwid).slice(-4) || "0000";
  return `Temp${suffix}A1`;
}

async function findAuthUserByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string,
) {
  const targetEmail = normalizeEmail(email, 320);
  if (!targetEmail) return null;
  let page = 1;
  const perPage = 200;
  while (page <= 25) {
    const listed = await supabase.auth.admin.listUsers({ page, perPage });
    if (listed.error) throw new Error(listed.error.message);
    const users = Array.isArray(listed.data?.users) ? listed.data.users : [];
    const found = users.find((user) => normalizeEmail(user.email ?? "", 320) === targetEmail);
    if (found) return found;
    if (users.length < perPage) break;
    page += 1;
  }
  return null;
}

async function ensureAuthUserForCreate(
  supabase: ReturnType<typeof createClient>,
  task: AuthProvisioningTaskRow,
  existingAppUser: AppUserRow | null,
  role: AppRole,
  loginEmail: string,
  displayName: string,
  tempPassword: string,
) {
  const metadata = asJsonRecord(task.payload.metadata);
  let authUserId = safeActorUserId(existingAppUser?.user_id ?? task.target_user_id ?? null);
  if (!authUserId) {
    const existingByEmail = await findAuthUserByEmail(supabase, loginEmail);
    if (existingByEmail) {
      authUserId = safeActorUserId(existingByEmail.id);
    }
  }

  if (!authUserId) {
    const createRes = await supabase.auth.admin.createUser({
      email: loginEmail,
      password: tempPassword,
      email_confirm: true,
      app_metadata: {
        source: "marketingtool_cloud_auth",
        role,
        wwid: normalizeWwid(task.target_wwid),
      },
      user_metadata: {
        display_name: displayName,
        first_name: normalizeText(metadata.first_name ?? "", 120),
        last_name: normalizeText(metadata.last_name ?? "", 120),
      },
    });
    if (createRes.error) {
      const duplicate = /already|exists|registered|duplicate/i.test(
        createRes.error.message || "",
      );
      if (!duplicate) throw new Error(createRes.error.message);
      const existingByEmail = await findAuthUserByEmail(supabase, loginEmail);
      const foundId = safeActorUserId(existingByEmail?.id ?? null);
      if (!foundId) throw new Error(createRes.error.message);
      authUserId = foundId;
    } else {
      authUserId = safeActorUserId(createRes.data.user?.id ?? null);
    }
  }

  if (!authUserId) {
    throw new Error("Cloud account setup could not get an auth user ID.");
  }

  const updateRes = await supabase.auth.admin.updateUserById(authUserId, {
    password: tempPassword,
    app_metadata: {
      source: "marketingtool_cloud_auth",
      role,
      wwid: normalizeWwid(task.target_wwid),
    },
    user_metadata: {
      display_name: displayName,
      first_name: normalizeText(metadata.first_name ?? "", 120),
      last_name: normalizeText(metadata.last_name ?? "", 120),
    },
  });
  if (updateRes.error) throw new Error(updateRes.error.message);
  return authUserId;
}

async function applyProvisioningTask(
  supabase: ReturnType<typeof createClient>,
  task: AuthProvisioningTaskRow,
  actor: RunActorMeta,
) {
  const taskType = normalizeTaskType(task.task_type);
  if (!taskType) throw new Error("Task type is invalid.");
  const targetWwid = normalizeWwid(task.target_wwid);
  if (!targetWwid) throw new Error("Task is missing WWID.");

  const payload = asJsonRecord(task.payload);
  const metadata = asJsonRecord(payload.metadata);
  const roleFromPayload = normalizeRole(payload.role ?? task.target_role ?? null);
  const role = roleFromPayload ?? "marketer";
  const displayName =
    normalizeText(payload.display_name ?? task.target_display_name, 120) ||
    normalizeText(
      `${normalizeText(metadata.first_name, 120)} ${normalizeText(metadata.last_name, 120)}`,
      120,
    ) ||
    "User";
  const workEmail = normalizeEmail(metadata.work_email ?? "", 320);
  const phone = normalizeText(metadata.phone ?? "", 40);
  const forcePasswordReset = normalizeBoolean(payload.force_password_reset, true);
  const targetStatus = normalizeUserStatus(payload.status);
  const nowIso = new Date().toISOString();
  const existing = await readAppUserByWwid(supabase, targetWwid);
  const beforeState = existing ? (JSON.parse(JSON.stringify(existing)) as JsonRecord) : {};

  if (taskType === "create_user") {
    const loginEmail =
      normalizeEmail(payload.login_email ?? existing?.login_email ?? "", 320) ||
      internalSyntheticLoginEmail(targetWwid);
    const tempPassword =
      normalizePasswordInput(metadata.temp_password ?? "", 256) ||
      buildFallbackTempPassword(targetWwid);

    const authUserId = await ensureAuthUserForCreate(
      supabase,
      task,
      existing,
      role,
      loginEmail,
      displayName,
      tempPassword,
    );

    if (existing) {
      const { error } = await supabase
        .from("app_users")
        .update({
          wwid: targetWwid,
          login_email: loginEmail,
          role,
          status: "active",
          force_password_reset: forcePasswordReset,
          cloud_account_state: "ready",
          cloud_account_last_error: "",
          cloud_account_ready_at: nowIso,
          first_name: normalizeText(metadata.first_name ?? existing.first_name, 120),
          last_name: normalizeText(metadata.last_name ?? existing.last_name, 120),
          work_email: workEmail || null,
          phone: phone || null,
          deleted_at: null,
          delete_reason: "",
        })
        .eq("user_id", authUserId);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("app_users").insert({
        user_id: authUserId,
        wwid: targetWwid,
        login_email: loginEmail,
        role,
        status: "active",
        force_password_reset: forcePasswordReset,
        cloud_account_state: "ready",
        cloud_account_last_error: "",
        cloud_account_ready_at: nowIso,
        first_name: normalizeText(metadata.first_name ?? "", 120),
        last_name: normalizeText(metadata.last_name ?? "", 120),
        work_email: workEmail || null,
        phone: phone || null,
      });
      if (error) throw new Error(error.message);
    }

    const afterState = await readAppUserByWwid(supabase, targetWwid);
    await updateTaskSuccess(supabase, task, authUserId);
    await writeUserAuditLog(supabase, {
      requestId: task.request_id,
      actorUserId: actor.actorUserId,
      actorRole: actor.actorRole,
      action: "create_user",
      targetUserId: authUserId,
      beforeState,
      afterState: asJsonRecord(afterState ?? {}),
      reason: "Cloud account provisioned during Save and Send.",
    });
    return;
  }

  if (!existing) {
    await updateTaskSuccess(supabase, task, null);
    return;
  }

  const patch: JsonRecord = {
    cloud_account_state: "ready",
    cloud_account_last_error: "",
    cloud_account_ready_at: nowIso,
  };

  if (taskType === "update_user") {
    if (roleFromPayload) {
      patch.role = roleFromPayload;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "force_password_reset")) {
      patch.force_password_reset = forcePasswordReset;
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "first_name")) {
      patch.first_name = normalizeText(metadata.first_name, 120);
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "last_name")) {
      patch.last_name = normalizeText(metadata.last_name, 120);
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "work_email")) {
      patch.work_email = workEmail || null;
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "phone")) {
      patch.phone = phone || null;
    }
  } else if (taskType === "set_user_status") {
    patch.status = targetStatus;
    if (targetStatus === "deleted") {
      patch.deleted_at = nowIso;
      patch.delete_reason = "Deleted by admin workflow.";
    } else {
      patch.deleted_at = null;
      patch.delete_reason = "";
    }
  } else if (taskType === "delete_user") {
    patch.status = "deleted";
    patch.deleted_at = nowIso;
    patch.delete_reason = "Deleted by admin workflow.";
  }

  const { error } = await supabase
    .from("app_users")
    .update(patch)
    .eq("user_id", existing.user_id);
  if (error) throw new Error(error.message);

  const afterState = await readAppUserByWwid(supabase, targetWwid);
  await updateTaskSuccess(supabase, task, existing.user_id);
  await writeUserAuditLog(supabase, {
    requestId: task.request_id,
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole,
    action: taskType,
    targetUserId: existing.user_id,
    beforeState,
    afterState: asJsonRecord(afterState ?? {}),
    reason: "Cloud user update applied from Save and Send queue.",
  });
}

async function runProvisioningPass(
  supabase: ReturnType<typeof createClient>,
  limit = PROVISIONING_BATCH_LIMIT,
) {
  const tasks = await listRunnableProvisioningTasks(supabase, limit);
  if (!tasks.length) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  const touchedRequestIds = new Set<string>();
  const runActorCache = new Map<string, RunActorMeta>();

  for (const task of tasks) {
    touchedRequestIds.add(normalizeText(task.request_id, 64).toLowerCase());
    try {
      const actor = await readRunActorMeta(supabase, task.request_id, runActorCache);
      await applyProvisioningTask(supabase, task, actor);
      succeeded += 1;
    } catch (error) {
      const message = normalizeText((error as Error)?.message ?? "Unknown provisioning error.", 500);
      failed += 1;
      await updateTaskFailure(supabase, task, message);
      if (normalizeTaskType(task.task_type) === "create_user") {
        try {
          await supabase
            .from("app_users")
            .update({
              cloud_account_state: "failed",
              cloud_account_last_error: message,
            })
            .eq("wwid_normalized", normalizeWwid(task.target_wwid));
        } catch {
          // Keep task failure state even if app_user update cannot be written.
        }
      }
    }
  }

  for (const requestId of touchedRequestIds) {
    try {
      await refreshSaveRunPendingCount(supabase, requestId);
    } catch {
      // Save run updates are best-effort during provisioning.
    }
  }

  return { processed: tasks.length, succeeded, failed };
}

async function signInViaAuthApi(
  supabaseUrl: string,
  clientApiKey: string,
  email: string,
  password: string,
) {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: clientApiKey,
      Authorization: `Bearer ${clientApiKey}`,
    },
    body: JSON.stringify({ email, password }),
  });
  const raw = await res.text();
  let data: JsonRecord = {};
  try {
    data = asJsonRecord(raw ? JSON.parse(raw) : {});
  } catch {
    data = {};
  }
  if (!res.ok) {
    const message = normalizeText(
      data.error_description ?? data.error ?? data.message ?? raw ?? "Sign-in failed.",
      300,
    );
    return { ok: false, message };
  }
  return { ok: true, message: "ok" };
}

async function probeClientApiKey(
  supabaseUrl: string,
  clientApiKey: string,
) {
  if (!clientApiKey) {
    return {
      ok: false,
      message: "Cloud connection needs admin attention. Reconnect cloud settings.",
    };
  }
  try {
    const probe = await signInViaAuthApi(
      supabaseUrl,
      clientApiKey,
      `healthcheck_${Date.now()}@invalid.local`,
      `invalid-${Date.now()}`,
    );
    if (probe.ok) {
      return { ok: true, message: "Cloud connection is ready." };
    }
    const invalidApiKey = /api key|apikey|unauthorized|forbidden/i.test(
      String(probe.message || ""),
    );
    if (invalidApiKey) {
      return {
        ok: false,
        message: "Cloud connection needs admin attention. Reconnect cloud settings.",
      };
    }
    // Invalid credentials on a probe request still means the key is accepted.
    return { ok: true, message: "Cloud connection is ready." };
  } catch {
    return {
      ok: false,
      message: "Cloud connection is temporarily unavailable. Please try again.",
    };
  }
}

async function handleCloudHealthCheck(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  clientApiKey: string,
) {
  try {
    const appUsersProbe = await supabase
      .from("app_users")
      .select("user_id", { head: true, count: "exact" })
      .limit(1);
    if (appUsersProbe.error) {
      return jsonResponse(200, {
        ok: false,
        message: "Cloud connection needs admin attention. Please reconnect cloud settings.",
      });
    }
  } catch {
    return jsonResponse(200, {
      ok: false,
      message: "Cloud connection is temporarily unavailable. Please try again.",
    });
  }

  const probe = await probeClientApiKey(supabaseUrl, clientApiKey);
  return jsonResponse(200, {
    ok: !!probe.ok,
    message: probe.message,
  });
}

async function handleCatalogGetLive(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const table = normalizeTableName(body.table);
  const stage = "published";
  const row = await supabase
    .from(table)
    .select("stage,payload,updated_at,updated_by")
    .eq("stage", stage)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (row.error) {
    return jsonResponse(500, {
      ok: false,
      message: "Could not load cloud catalog right now.",
      details: normalizeText(row.error.message, 300),
    });
  }
  if (!row.data) {
    return jsonResponse(200, {
      ok: false,
      message: `No published cloud snapshot found in "${table}".`,
      row: null,
    });
  }
  return jsonResponse(200, {
    ok: true,
    message: "Cloud catalog loaded.",
    row: row.data as JsonRecord,
  });
}

async function handleBookingGet(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const table = normalizeTableName(body.table);
  const stageRaw = normalizeText(body.stage, 80).toLowerCase();
  const stage = stageRaw || "booking_requests";
  const claimsTable = normalizeTableName(body.claims_table || "booking_request_claims");

  const row = await supabase
    .from(table)
    .select("stage,payload,updated_at,updated_by")
    .eq("stage", stage)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (row.error) {
    return jsonResponse(500, {
      ok: false,
      message: "Could not load cloud booking queue right now.",
      details: normalizeText(row.error.message, 300),
    });
  }

  const locks = await supabase
    .from(claimsTable)
    .select(
      "request_id,status,claimed_by_name,claimed_by_user_id,claimed_by_device,claimed_at,completed_by_name,completed_by_user_id,completed_by_device,completed_at,updated_at",
    )
    .in("status", ["working", "done"])
    .order("updated_at", { ascending: false });
  if (locks.error) {
    return jsonResponse(500, {
      ok: false,
      message: "Could not load booking ownership status right now.",
      details: normalizeText(locks.error.message, 300),
    });
  }

  return jsonResponse(200, {
    ok: true,
    message: "Cloud booking queue loaded.",
    row: (row.data as JsonRecord | null) ?? null,
    locks: Array.isArray(locks.data) ? locks.data : [],
  });
}

async function handleBookingSave(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const table = normalizeTableName(body.table);
  const stageRaw = normalizeText(body.stage, 80).toLowerCase();
  const stage = stageRaw || "booking_requests";
  const payload = asJsonRecord(body.payload);
  const actorName = normalizeText(body.actor_name, 120) || "app-client";
  const updatedAt = new Date().toISOString();

  const upserted = await supabase
    .from(table)
    .upsert(
      {
        stage,
        payload,
        updated_at: updatedAt,
        updated_by: actorName,
      },
      { onConflict: "stage" },
    )
    .select("stage,payload,updated_at,updated_by")
    .limit(1)
    .maybeSingle();

  if (upserted.error) {
    return jsonResponse(500, {
      ok: false,
      message: "Could not save booking updates to cloud.",
      details: normalizeText(upserted.error.message, 300),
    });
  }

  return jsonResponse(200, {
    ok: true,
    message: "Booking updates synced to cloud.",
    row: (upserted.data as JsonRecord | null) ?? null,
  });
}

const BOOKING_CLAIM_SELECT =
  "request_id,status,claimed_by_name,claimed_by_user_id,claimed_by_device,claimed_at,completed_by_name,completed_by_user_id,completed_by_device,completed_at,updated_at";

function normalizeBookingClaimStatus(input: unknown) {
  const value = String(input ?? "").trim().toLowerCase();
  return value === "done" ? "done" : "working";
}

function bookingActorIdText(userId: unknown, device: unknown) {
  const user = normalizeText(userId, 120);
  const dev = normalizeText(device, 120);
  return user || dev;
}

function bookingClaimOwnedByActor(
  row: JsonRecord,
  actorName: string,
  actorUserId: string,
  actorDevice: string,
) {
  const claimedUserId = normalizeText(row.claimed_by_user_id, 120);
  const claimedDevice = normalizeText(row.claimed_by_device, 120);
  const claimedName = normalizeText(row.claimed_by_name, 120).toLowerCase();
  const actorNameNorm = normalizeText(actorName, 120).toLowerCase();
  if (actorUserId && claimedUserId) return actorUserId === claimedUserId;
  if (actorDevice && claimedDevice) return actorDevice === claimedDevice;
  if (actorNameNorm && claimedName) return actorNameNorm === claimedName;
  return false;
}

function bookingOwnerLabel(row: JsonRecord, preferCompleted = false) {
  const claimedName = normalizeText(row.claimed_by_name, 120);
  const claimedId = bookingActorIdText(row.claimed_by_user_id, row.claimed_by_device);
  const completedName = normalizeText(row.completed_by_name, 120);
  const completedId = bookingActorIdText(row.completed_by_user_id, row.completed_by_device);
  const name = preferCompleted ? completedName || claimedName : claimedName || completedName;
  const id = preferCompleted ? completedId || claimedId : claimedId || completedId;
  return `${name || "another admin"}${id ? ` (${id})` : ""}`;
}

async function handleBookingClaim(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const claimsTable = normalizeTableName(body.claims_table || "booking_request_claims");
  const requestId = normalizeText(body.request_id, 160);
  const actorName = normalizeText(body.actor_name, 120);
  const actorUserId = normalizeText(body.actor_user_id, 120);
  const actorDevice = normalizeText(body.actor_device, 120);
  if (!requestId) {
    return jsonResponse(400, { ok: false, reason: "missing", message: "Request id is required." });
  }
  if (!actorName && !actorUserId && !actorDevice) {
    return jsonResponse(200, {
      ok: false,
      reason: "missing-actor",
      message: "Select your admin name in Book & Send Queue first.",
    });
  }

  const existingRes = await supabase
    .from(claimsTable)
    .select(BOOKING_CLAIM_SELECT)
    .eq("request_id", requestId)
    .maybeSingle();
  if (existingRes.error) {
    return jsonResponse(500, {
      ok: false,
      reason: "read-failed",
      message: "Could not load booking ownership status right now.",
      details: normalizeText(existingRes.error.message, 300),
    });
  }

  const existing = existingRes.data ? asJsonRecord(existingRes.data) : null;
  if (existing) {
    const status = normalizeBookingClaimStatus(existing.status);
    if (status === "done") {
      return jsonResponse(200, {
        ok: false,
        reason: "already-done",
        lock: existing,
        message: `Already marked Done by ${bookingOwnerLabel(existing, true)}.`,
      });
    }
    if (bookingClaimOwnedByActor(existing, actorName, actorUserId, actorDevice)) {
      return jsonResponse(200, {
        ok: true,
        lock: existing,
        message: "Already claimed by you.",
      });
    }
    return jsonResponse(200, {
      ok: false,
      reason: "owner-locked",
      lock: existing,
      message: `Already claimed by ${bookingOwnerLabel(existing)}.`,
    });
  }

  const stamp = new Date().toISOString();
  const upserted = await supabase
    .from(claimsTable)
    .upsert(
      [
        {
          request_id: requestId,
          status: "working",
          claimed_by_name: actorName || null,
          claimed_by_user_id: actorUserId || null,
          claimed_by_device: actorDevice || null,
          claimed_at: stamp,
          updated_at: stamp,
          completed_by_name: null,
          completed_by_user_id: null,
          completed_by_device: null,
          completed_at: null,
        },
      ],
      { onConflict: "request_id" },
    )
    .select(BOOKING_CLAIM_SELECT)
    .limit(1)
    .maybeSingle();
  if (upserted.error) {
    return jsonResponse(500, {
      ok: false,
      reason: "claim-failed",
      message: "Could not claim this request right now. Please refresh and try again.",
      details: normalizeText(upserted.error.message, 300),
    });
  }

  return jsonResponse(200, {
    ok: true,
    message: "Request marked Working.",
    lock: (upserted.data as JsonRecord | null) ?? null,
  });
}

async function handleBookingComplete(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const claimsTable = normalizeTableName(body.claims_table || "booking_request_claims");
  const requestId = normalizeText(body.request_id, 160);
  const actorName = normalizeText(body.actor_name, 120);
  const actorUserId = normalizeText(body.actor_user_id, 120);
  const actorDevice = normalizeText(body.actor_device, 120);
  if (!requestId) {
    return jsonResponse(400, { ok: false, reason: "missing", message: "Request id is required." });
  }
  if (!actorName && !actorUserId && !actorDevice) {
    return jsonResponse(200, {
      ok: false,
      reason: "missing-actor",
      message: "Select your admin name in Book & Send Queue first.",
    });
  }

  const existingRes = await supabase
    .from(claimsTable)
    .select(BOOKING_CLAIM_SELECT)
    .eq("request_id", requestId)
    .maybeSingle();
  if (existingRes.error) {
    return jsonResponse(500, {
      ok: false,
      reason: "read-failed",
      message: "Could not load booking ownership status right now.",
      details: normalizeText(existingRes.error.message, 300),
    });
  }

  const existing = existingRes.data ? asJsonRecord(existingRes.data) : null;
  if (!existing) {
    return jsonResponse(200, {
      ok: false,
      reason: "missing-owner",
      message: "Mark this request as Working first so ownership is assigned.",
    });
  }

  const status = normalizeBookingClaimStatus(existing.status);
  const ownedByActor = bookingClaimOwnedByActor(existing, actorName, actorUserId, actorDevice);
  if (status === "done") {
    if (ownedByActor) {
      return jsonResponse(200, {
        ok: true,
        already_done: true,
        lock: existing,
        message: "Request already marked Done.",
      });
    }
    return jsonResponse(200, {
      ok: false,
      reason: "already-done",
      lock: existing,
      message: `Already marked Done by ${bookingOwnerLabel(existing, true)}.`,
    });
  }

  if (!ownedByActor) {
    return jsonResponse(200, {
      ok: false,
      reason: "owner-only-done",
      lock: existing,
      message: `Only ${bookingOwnerLabel(existing)} can mark Done.`,
    });
  }

  const stamp = new Date().toISOString();
  const updated = await supabase
    .from(claimsTable)
    .update({
      status: "done",
      completed_by_name: actorName || null,
      completed_by_user_id: actorUserId || null,
      completed_by_device: actorDevice || null,
      completed_at: stamp,
      updated_at: stamp,
    })
    .eq("request_id", requestId)
    .select(BOOKING_CLAIM_SELECT)
    .limit(1)
    .maybeSingle();
  if (updated.error) {
    return jsonResponse(500, {
      ok: false,
      reason: "done-failed",
      message: "Could not mark this request as Done right now.",
      details: normalizeText(updated.error.message, 300),
    });
  }

  return jsonResponse(200, {
    ok: true,
    message: "Request marked Done.",
    lock: (updated.data as JsonRecord | null) ?? null,
  });
}

async function handleBookingRelease(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const claimsTable = normalizeTableName(body.claims_table || "booking_request_claims");
  const requestId = normalizeText(body.request_id, 160);
  if (!requestId) {
    return jsonResponse(400, { ok: false, reason: "missing", message: "Request id is required." });
  }
  const deleted = await supabase.from(claimsTable).delete().eq("request_id", requestId);
  if (deleted.error) {
    return jsonResponse(500, {
      ok: false,
      reason: "release-failed",
      message: "Could not clear booking ownership right now.",
      details: normalizeText(deleted.error.message, 300),
    });
  }
  return jsonResponse(200, {
    ok: true,
    message: "Booking ownership cleared.",
  });
}

async function handleAuthLookup(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const role = normalizeUiRole(body.role);
  const identifier = normalizeIdentifier(body.identifier, 320);

  await runProvisioningPass(supabase, PROVISIONING_BATCH_LIMIT);

  if (!identifier) {
    return jsonResponse(200, {
      ok: true,
      found: false,
      message: "Cloud user lookup is ready.",
    });
  }

  const user = await readAppUserByIdentifier(supabase, identifier, role);
  if (!user) {
    const pending = await readPendingTaskForWwid(supabase, identifier);
    if (pending) {
      return jsonResponse(200, {
        ok: true,
        found: false,
        account_state: "pending",
        message: "Account setup is still in progress.",
      });
    }
    return jsonResponse(200, {
      ok: true,
      found: false,
      account_state: "missing",
      message: "No account matched that role and login.",
    });
  }

  const profile = publicUserProfile(user);
  return jsonResponse(200, {
    ok: true,
    found: true,
    message: "Cloud account found.",
    user: {
      role: profile.role,
      status: profile.status,
      force_password_reset: !!profile.force_password_reset,
      cloud_account_state: profile.cloud_account_state,
      wwid: profile.wwid,
      work_email: profile.work_email,
      updated_at: profile.updated_at,
    },
  });
}

async function handleAuthSignIn(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  clientApiKey: string,
  body: JsonRecord,
) {
  const role = normalizeUiRole(body.role);
  const identifier = normalizeIdentifier(body.identifier, 320);
  const password = normalizePasswordInput(body.password, 512);
  if (!identifier || !password) {
    return jsonResponse(400, {
      ok: false,
      hard_fail: false,
      message: "Enter role, work email/WWID, and password.",
    });
  }
  if (!clientApiKey) {
    return jsonResponse(200, {
      ok: false,
      hard_fail: false,
      message: "Cloud sign-in is not ready yet. Ask admin to reconnect cloud settings.",
    });
  }

  await runProvisioningPass(supabase, PROVISIONING_BATCH_LIMIT);

  const user = await readAppUserByIdentifier(supabase, identifier, role);
  if (!user) {
    const maybePending = await readPendingTaskForWwid(supabase, identifier);
    if (maybePending) {
      return jsonResponse(200, {
        ok: false,
        hard_fail: true,
        message:
          "Your account is still being set up in the cloud. Ask admin to click Save and Send again, then retry.",
      });
    }
    return jsonResponse(200, {
      ok: false,
      hard_fail: true,
      message: "No active account matched that role + login.",
    });
  }

  if (!appRoleMatchesUiRole(user.role, role)) {
    return jsonResponse(200, {
      ok: false,
      hard_fail: true,
      message: "This account does not have access to that role.",
    });
  }
  if (user.deleted_at || user.status !== "active") {
    return jsonResponse(200, {
      ok: false,
      hard_fail: true,
      message: "This account is inactive. Ask a Primary Admin for help.",
    });
  }
  if (user.cloud_account_state === "pending") {
    return jsonResponse(200, {
      ok: false,
      hard_fail: true,
      message:
        "Your account is still being set up in the cloud. Ask admin to click Save and Send again, then retry.",
    });
  }
  if (user.cloud_account_state === "failed") {
    return jsonResponse(200, {
      ok: false,
      hard_fail: true,
      message:
        "Your cloud account setup needs attention. Ask admin to click Save and Send again.",
    });
  }

  const loginEmail = normalizeEmail(user.login_email, 320);
  if (!loginEmail) {
    return jsonResponse(200, {
      ok: false,
      hard_fail: true,
      message:
        "This account is missing cloud login details. Ask admin to click Save and Send again.",
    });
  }

  let signInResult: { ok: boolean; message: string };
  try {
    signInResult = await signInViaAuthApi(
      supabaseUrl,
      clientApiKey,
      loginEmail,
      password,
    );
  } catch {
    return jsonResponse(200, {
      ok: false,
      hard_fail: false,
      message: "Could not sign in right now. Please try again.",
    });
  }
  if (!signInResult.ok) {
    const invalidPassword = /password|credentials/i.test(signInResult.message);
    const invalidApiKey = /api key|apikey|unauthorized|forbidden/i.test(signInResult.message);
    return jsonResponse(200, {
      ok: false,
      hard_fail: true,
      message: invalidApiKey
        ? "Cloud sign-in is unavailable right now. Ask admin to reconnect cloud settings."
        : invalidPassword
        ? "Password did not match."
        : "Could not sign in right now. Please try again.",
    });
  }

  const profile = publicUserProfile(user);
  if (profile.force_password_reset) {
    return jsonResponse(200, {
      ok: true,
      hard_fail: false,
      message: "Temporary password accepted. Set a new password to continue.",
      user: profile,
    });
  }
  return jsonResponse(200, {
    ok: true,
    hard_fail: false,
    message: `Signed in as ${role}.`,
    user: profile,
  });
}

async function handleAuthCompletePasswordReset(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  clientApiKey: string,
  body: JsonRecord,
) {
  const role = normalizeUiRole(body.role);
  const identifier = normalizeIdentifier(body.identifier, 320);
  const currentPassword = normalizePasswordInput(body.current_password, 512);
  const newPassword = normalizePasswordInput(body.new_password, 512);

  if (!identifier || !currentPassword || !newPassword) {
    return jsonResponse(400, {
      ok: false,
      message: "Password reset details are incomplete.",
    });
  }
  if (!clientApiKey) {
    return jsonResponse(200, {
      ok: false,
      message: "Cloud sign-in is not ready yet. Ask admin to reconnect cloud settings.",
    });
  }
  if (!isStrongPassword(newPassword)) {
    return jsonResponse(200, {
      ok: false,
      message: "New password must include at least 1 capital letter and at least 1 number.",
    });
  }
  if (newPassword === currentPassword) {
    return jsonResponse(200, {
      ok: false,
      message: "New password must be different from temporary password.",
    });
  }

  await runProvisioningPass(supabase, PROVISIONING_BATCH_LIMIT);

  const user = await readAppUserByIdentifier(supabase, identifier, role);
  if (!user || !appRoleMatchesUiRole(user.role, role) || user.deleted_at || user.status !== "active") {
    return jsonResponse(200, {
      ok: false,
      message: "This account is inactive. Ask a Primary Admin for help.",
    });
  }
  if (user.cloud_account_state === "pending") {
    return jsonResponse(200, {
      ok: false,
      message:
        "Your account is still being set up in the cloud. Ask admin to click Save and Send again, then retry.",
    });
  }
  if (user.cloud_account_state === "failed") {
    return jsonResponse(200, {
      ok: false,
      message:
        "Your cloud account setup needs attention. Ask admin to click Save and Send again.",
    });
  }

  const loginEmail = normalizeEmail(user.login_email, 320);
  if (!loginEmail) {
    return jsonResponse(200, {
      ok: false,
      message:
        "This account is missing cloud login details. Ask admin to click Save and Send again.",
    });
  }

  let verify: { ok: boolean; message: string };
  try {
    verify = await signInViaAuthApi(
      supabaseUrl,
      clientApiKey,
      loginEmail,
      currentPassword,
    );
  } catch {
    return jsonResponse(200, {
      ok: false,
      message: "Could not verify current password. Please try again.",
    });
  }
  if (!verify.ok) {
    const invalidApiKey = /api key|apikey|unauthorized|forbidden/i.test(verify.message);
    const invalidPassword = /password|credentials/i.test(verify.message);
    return jsonResponse(200, {
      ok: false,
      message: invalidApiKey
        ? "Cloud sign-in is unavailable right now. Ask admin to reconnect cloud settings."
        : invalidPassword
        ? "Current password did not match."
        : "Could not verify current password. Please try again.",
    });
  }

  const updateAuth = await supabase.auth.admin.updateUserById(user.user_id, {
    password: newPassword,
  });
  if (updateAuth.error) {
    return jsonResponse(500, {
      ok: false,
      message: "Could not update password right now. Please try again.",
      details: normalizeText(updateAuth.error.message, 300),
    });
  }

  const { error: updateProfileError } = await supabase
    .from("app_users")
    .update({
      force_password_reset: false,
      cloud_account_state: "ready",
      cloud_account_last_error: "",
      cloud_account_ready_at: new Date().toISOString(),
    })
    .eq("user_id", user.user_id);
  if (updateProfileError) {
    return jsonResponse(500, {
      ok: false,
      message: "Password updated, but profile sync needs attention.",
      details: normalizeText(updateProfileError.message, 300),
    });
  }

  const refreshed = await readAppUserByWwid(supabase, user.wwid);
  const profile = publicUserProfile(refreshed ?? user);
  return jsonResponse(200, {
    ok: true,
    message: "Password updated.",
    user: profile,
  });
}

async function fetchExistingRun(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
) {
  const existing = await supabase
    .from("save_send_runs")
    .select("*")
    .eq("request_id", requestId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  return existing.data as JsonRecord | null;
}

async function handleSaveAndSend(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const table = normalizeTableName(body.table);
  const actorName = normalizeText(body.actor_name, 120) || "Primary Admin";
  const actorRole = normalizeText(body.actor_role, 64) || "primary_admin";
  const actorUserId = safeActorUserId(body.actor_user_id);
  const requestIdRaw = normalizeText(body.request_id, 64).toLowerCase();
  const requestId = isUuid(requestIdRaw) ? requestIdRaw : crypto.randomUUID();

  const payload = sanitizeCatalogPayload(body.payload);
  if (!Array.isArray(payload.brands) || !Array.isArray(payload.ticketLines)) {
    return jsonResponse(400, {
      ok: false,
      request_id: requestId,
      message: "Catalog payload is missing brands or ticket lines.",
    });
  }
  if (!payload.brands.length || !payload.ticketLines.length) {
    return jsonResponse(400, {
      ok: false,
      request_id: requestId,
      message: "Add at least one brand and ticket line before Save and Send.",
    });
  }

  const userOps = normalizeUserOperations(body.user_operations);
  const requestHash = await sha256(
    JSON.stringify({ table, payload, user_operations: userOps }),
  );

  const existing = await fetchExistingRun(supabase, requestId);
  if (existing) {
    const existingHash = normalizeText(existing.request_hash, 200);
    const existingStatus = normalizeText(existing.status, 64) as SaveRunStatus;
    if (existingHash && existingHash !== requestHash) {
      return jsonResponse(409, {
        ok: false,
        request_id: requestId,
        message:
          "This Save and Send request ID was already used for different data. Please retry.",
      });
    }
    if (
      existingStatus === "succeeded" ||
      existingStatus === "succeeded_with_pending_auth"
    ) {
      const pending = Number(existing.auth_tasks_pending ?? 0) || 0;
      const resultPayload =
        existing.result_payload && typeof existing.result_payload === "object"
          ? (existing.result_payload as JsonRecord)
          : {};
      return jsonResponse(200, {
        ok: true,
        idempotent: true,
        request_id: requestId,
        message: safeAdminMessage(existingStatus, pending),
        ...resultPayload,
      });
    }
  }

  await upsertSaveRunStart(
    supabase,
    requestId,
    actorUserId,
    actorRole,
    requestHash,
  );

  try {
    const { publishedAt, version } = await upsertCatalogStages(
      supabase,
      table,
      payload,
      actorName,
    );
    const userResult = await queueUserProvisioningTasks(supabase, requestId, userOps);
    await runProvisioningPass(
      supabase,
      Math.max(PROVISIONING_BATCH_LIMIT, userResult.queuedOpsCount),
    );
    const pendingAuthCount = await countPendingTasksForRequest(supabase, requestId);
    const hasPendingAuth = pendingAuthCount > 0;
    const status: SaveRunStatus = hasPendingAuth
      ? "succeeded_with_pending_auth"
      : "succeeded";

    const resultPayload: JsonRecord = {
      version,
      published_at: publishedAt,
      account_readiness: {
        pending: pendingAuthCount,
        ready: Math.max(0, userResult.pendingAccountCount - pendingAuthCount),
        failed: 0,
      },
      user_operations: {
        received: userOps.length,
        queued: userResult.queuedOpsCount,
      },
    };

    await finalizeSaveRun(
      supabase,
      requestId,
      status,
      true,
      userResult.queuedOpsCount > 0,
      pendingAuthCount,
      resultPayload,
    );

    return jsonResponse(200, {
      ok: true,
      request_id: requestId,
      message: safeAdminMessage(status, pendingAuthCount),
      ...resultPayload,
    });
  } catch (error) {
    const errMessage = normalizeText((error as Error)?.message, 500) || "Unknown error";
    try {
      await finalizeSaveRun(
        supabase,
        requestId,
        "failed",
        false,
        false,
        0,
        {},
        errMessage,
      );
    } catch {
      // Ignore run-finalization failure so caller still receives a useful error.
    }
    return jsonResponse(500, {
      ok: false,
      request_id: requestId,
      message: "Cloud sync could not finish. Please try Save and Send again.",
      details: errMessage,
    });
  }
}

async function handleScanMigrationConflicts(
  supabase: ReturnType<typeof createClient>,
  body: JsonRecord,
) {
  const users = Array.isArray(body.users) ? body.users : [];
  const actorUserId = safeActorUserId(body.actor_user_id);
  const sourceLabel = normalizeText(body.source_label, 120) || "local_export";

  const scan = await supabase.rpc("app_create_migration_conflict_report", {
    p_started_by: actorUserId,
    p_source_label: sourceLabel,
    p_users: users,
  });
  if (scan.error) {
    return jsonResponse(500, {
      ok: false,
      message: "Could not generate migration conflict report.",
      details: scan.error.message,
    });
  }

  const row = Array.isArray(scan.data) ? scan.data[0] : null;
  const runId = normalizeText(row?.migration_run_id, 80);
  const conflictCount = Number(row?.conflict_count ?? 0) || 0;
  const status = normalizeText(row?.status, 64) || "unknown";

  let conflicts: unknown[] = [];
  if (runId) {
    const list = await supabase
      .from("user_migration_conflicts")
      .select(
        "conflict_type,wwid_normalized,local_row_ids,roles,reason,sample_records,created_at",
      )
      .eq("migration_run_id", runId)
      .order("id", { ascending: true });
    if (list.error) {
      return jsonResponse(500, {
        ok: false,
        message: "Conflict report was started, but conflict rows could not be read.",
        details: list.error.message,
      });
    }
    conflicts = Array.isArray(list.data) ? list.data : [];
  }

  return jsonResponse(200, {
    ok: true,
    message:
      conflictCount > 0
        ? "Migration needs review before import. Duplicate WWIDs have conflicting records."
        : "No conflicting duplicate WWIDs found.",
    migration_run_id: runId,
    status,
    conflict_count: conflictCount,
    conflicts,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, message: "Use POST for this endpoint." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, {
      ok: false,
      message: "Server is missing Supabase service credentials.",
    });
  }

  let body: JsonRecord = {};
  try {
    body = (await req.json()) as JsonRecord;
  } catch {
    return jsonResponse(400, { ok: false, message: "Request body must be valid JSON." });
  }

  const actionRaw = normalizeText(body.action, 80).toLowerCase();
  const action = actionRaw === "save_and_sync" ? "save_and_send" : actionRaw;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const headerApiKey = normalizeText(req.headers.get("apikey") ?? "", 500);
  const authHeader = normalizeText(req.headers.get("authorization") ?? "", 500);
  const bearerKey = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const clientApiKey = headerApiKey || bearerKey;
  const authApiKey = resolveClientApiKey(clientApiKey, serviceRoleKey);

  if (action === "save_and_send") {
    return handleSaveAndSend(supabase, body);
  }
  if (action === "scan_migration_conflicts") {
    return handleScanMigrationConflicts(supabase, body);
  }
  if (action === "auth_sign_in") {
    return handleAuthSignIn(supabase, supabaseUrl, authApiKey, body);
  }
  if (action === "auth_complete_password_reset") {
    return handleAuthCompletePasswordReset(supabase, supabaseUrl, authApiKey, body);
  }
  if (action === "health_check") {
    return handleCloudHealthCheck(supabase, supabaseUrl, authApiKey);
  }
  if (action === "catalog_get_live") {
    return handleCatalogGetLive(supabase, body);
  }
  if (action === "booking_get") {
    return handleBookingGet(supabase, body);
  }
  if (action === "booking_save") {
    return handleBookingSave(supabase, body);
  }
  if (action === "booking_claim") {
    return handleBookingClaim(supabase, body);
  }
  if (action === "booking_complete") {
    return handleBookingComplete(supabase, body);
  }
  if (action === "booking_release") {
    return handleBookingRelease(supabase, body);
  }
  if (action === "auth_lookup") {
    return handleAuthLookup(supabase, body);
  }

  return jsonResponse(400, {
    ok: false,
    message: `Unsupported action "${actionRaw || "unknown"}".`,
  });
});

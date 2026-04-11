import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { seedBrands, seedTicketLines, seedUsers } from "../data/seed";
import { Brand, TicketLine, User } from "../types";
import {
  canReadRemoteAlerts,
  canWriteRemoteAlerts,
  fetchRemoteAlerts,
  normalizeBrandKey,
  normalizeRemoteAlertsConfig,
  readRemoteConfigError,
  readRemoteWriteConfigError,
  RemoteAlertsConfig,
  upsertRemoteAlert
} from "../services/remoteAlerts";

interface AddTicketLinePayload {
  ticketLabel: string;
  qualifierText: string;
  retailPrice: number;
  cmaPrice: number;
  active: boolean;
}

interface AppDataContextValue {
  users: User[];
  brands: Brand[];
  ticketLines: TicketLine[];
  remoteConfig: RemoteAlertsConfig;
  remoteStatusMessage: string;
  remoteStatusIsError: boolean;
  remoteStatusAt: string;
  addBrand: (name: string) => void;
  updateBrand: (brandId: string, updates: Partial<Pick<Brand, "name" | "active">>) => void;
  sendShowAlert: (brandId: string, message: string) => void;
  clearShowAlert: (brandId: string) => void;
  setBrandFrequentAlert: (brandId: string, isFrequent: boolean) => void;
  updateRemoteConfig: (updates: Partial<RemoteAlertsConfig>) => void;
  syncRemoteAlerts: () => Promise<void>;
  duplicateBrand: (brandId: string) => void;
  deleteBrand: (brandId: string) => void;
  addTicketLine: (brandId: string, payload: AddTicketLinePayload) => void;
  updateTicketLine: (lineId: string, updates: Partial<Pick<TicketLine, "ticketLabel" | "qualifierText" | "retailPrice" | "cmaPrice" | "active">>) => void;
  duplicateTicketLine: (lineId: string) => void;
  deleteTicketLine: (lineId: string) => void;
  addAdminUser: (name: string, emailOrLogin: string) => void;
  toggleAdminActive: (userId: string) => void;
}

const AppDataContext = createContext<AppDataContextValue | undefined>(undefined);

const STORAGE_KEY = "premium_pricing_app_state_v1";
const REMOTE_SYNC_POLL_MS = 15000;
const DEFAULT_REMOTE_ALERTS_CONFIG = normalizeRemoteAlertsConfig();

function hasLocalStorage(): boolean {
  try {
    return typeof globalThis !== "undefined" && typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function normalizePersistedBrand(brand: unknown): Brand | null {
  if (!brand || typeof brand !== "object") {
    return null;
  }

  const raw = brand as Partial<Brand>;
  const timestamp = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso();
  const normalizedName = typeof raw.name === "string" ? raw.name.trim() : "";

  if (!normalizedName) {
    return null;
  }

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId("brand"),
    name: normalizedName,
    active: typeof raw.active === "boolean" ? raw.active : true,
    frequentAlert: typeof raw.frequentAlert === "boolean" ? raw.frequentAlert : false,
    showAlertActive: typeof raw.showAlertActive === "boolean" ? raw.showAlertActive : false,
    showAlertMessage: typeof raw.showAlertMessage === "string" ? raw.showAlertMessage : "",
    showAlertSentAt: typeof raw.showAlertSentAt === "string" ? raw.showAlertSentAt : "",
    showAlertUpdatedAt: typeof raw.showAlertUpdatedAt === "string" ? raw.showAlertUpdatedAt : "",
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : timestamp,
    updatedAt: timestamp
  };
}

function loadPersistedState():
  | {
      users: User[];
      brands: Brand[];
      ticketLines: TicketLine[];
      remoteConfig: RemoteAlertsConfig;
    }
  | null {
  if (!hasLocalStorage()) {
    return null;
  }

  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.brands) || !Array.isArray(parsed.ticketLines)) {
      return null;
    }

    const normalizedBrands = parsed.brands
      .map((item: unknown) => normalizePersistedBrand(item))
      .filter((item: Brand | null): item is Brand => !!item);

    return {
      users: parsed.users,
      brands: normalizedBrands,
      ticketLines: parsed.ticketLines,
      remoteConfig: normalizeRemoteAlertsConfig(
        parsed.remoteConfig && typeof parsed.remoteConfig === "object" ? parsed.remoteConfig : null
      )
    };
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const persisted = loadPersistedState();
  const [users, setUsers] = useState<User[]>(persisted?.users ?? seedUsers);
  const [brands, setBrands] = useState<Brand[]>(persisted?.brands ?? seedBrands);
  const [ticketLines, setTicketLines] = useState<TicketLine[]>(persisted?.ticketLines ?? seedTicketLines);
  const [remoteConfig, setRemoteConfig] = useState<RemoteAlertsConfig>(
    persisted?.remoteConfig ?? DEFAULT_REMOTE_ALERTS_CONFIG
  );
  const [remoteStatusMessage, setRemoteStatusMessage] = useState("");
  const [remoteStatusIsError, setRemoteStatusIsError] = useState(false);
  const [remoteStatusAt, setRemoteStatusAt] = useState("");

  useEffect(() => {
    if (!hasLocalStorage()) {
      return;
    }

    try {
      globalThis.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          users,
          brands,
          ticketLines,
          remoteConfig
        })
      );
    } catch {
      // Ignore persistence failures so the app remains usable.
    }
  }, [users, brands, ticketLines, remoteConfig]);

  function addBrand(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    const timestamp = nowIso();

    setBrands((prev) => [
      ...prev,
      {
        id: newId("brand"),
        name: trimmed,
        active: true,
        frequentAlert: false,
        showAlertActive: false,
        showAlertMessage: "",
        showAlertSentAt: "",
        showAlertUpdatedAt: "",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]);
  }

  function setRemoteStatus(message: string, isError = false) {
    setRemoteStatusMessage(String(message || ""));
    setRemoteStatusIsError(isError);
    setRemoteStatusAt(nowIso());
  }

  function updateRemoteConfig(updates: Partial<RemoteAlertsConfig>) {
    setRemoteConfig((prev) => normalizeRemoteAlertsConfig({ ...prev, ...updates }));
  }

  const syncRemoteAlertsInternal = useCallback(
    async (silent: boolean) => {
      const readError = readRemoteConfigError(remoteConfig);
      if (readError) {
        if (!silent) {
          setRemoteStatus(readError, true);
        }
        return;
      }

      try {
        const rows = await fetchRemoteAlerts(remoteConfig);
        const byBrandId = new Map(rows.map((row) => [String(row.brand_id || "").trim(), row]));
        const byBrandKey = new Map(rows.map((row) => [normalizeBrandKey(String(row.brand_name || "")), row]));

        setBrands((prev) =>
          prev.map((brand) => {
            const byId = byBrandId.get(brand.id);
            const byName = byBrandKey.get(normalizeBrandKey(brand.name));
            const row = byId ?? byName;

            if (!row) {
              return brand;
            }

            const updatedAt = typeof row.updated_at === "string" && row.updated_at ? row.updated_at : brand.updatedAt;
            const sentAt = typeof row.sent_at === "string" && row.sent_at ? row.sent_at : "";

            return {
              ...brand,
              frequentAlert: !!row.frequent_alert,
              showAlertActive: !!row.alert_active,
              showAlertMessage: typeof row.alert_message === "string" ? row.alert_message : "",
              showAlertSentAt: sentAt,
              showAlertUpdatedAt: updatedAt,
              updatedAt
            };
          })
        );

        if (!silent) {
          setRemoteStatus(`Synced ${rows.length} alert rows from cloud.`, false);
        }
      } catch (error) {
        const message = String((error as Error)?.message || error || "Remote alert sync failed.");
        if (!silent) {
          setRemoteStatus(message, true);
        }
      }
    },
    [remoteConfig]
  );

  const syncRemoteAlerts = useCallback(async () => {
    await syncRemoteAlertsInternal(false);
  }, [syncRemoteAlertsInternal]);

  useEffect(() => {
    if (!remoteConfig.autoSync || !canReadRemoteAlerts(remoteConfig)) {
      return;
    }

    void syncRemoteAlertsInternal(true);
    const intervalId = globalThis.setInterval(() => {
      void syncRemoteAlertsInternal(true);
    }, REMOTE_SYNC_POLL_MS);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [
    remoteConfig.autoSync,
    remoteConfig.supabaseUrl,
    remoteConfig.anonKey,
    remoteConfig.alertsTable,
    syncRemoteAlertsInternal
  ]);

  const pushBrandAlertToRemote = useCallback(
    async (brand: Brand) => {
      if (!canWriteRemoteAlerts(remoteConfig)) {
        const writeError = readRemoteWriteConfigError(remoteConfig);
        if (writeError) {
          setRemoteStatus(writeError, true);
        }
        return;
      }

      try {
        await upsertRemoteAlert(remoteConfig, {
          brandId: brand.id,
          brandName: brand.name,
          alertActive: brand.showAlertActive,
          alertMessage: brand.showAlertMessage,
          frequentAlert: brand.frequentAlert,
          sentAt: brand.showAlertSentAt,
          updatedAt: brand.showAlertUpdatedAt || brand.updatedAt,
          updatedBy: "admin-react"
        });
        setRemoteStatus(`Broadcast synced for ${brand.name}.`, false);
      } catch (error) {
        const message = String((error as Error)?.message || error || "Remote alert publish failed.");
        setRemoteStatus(message, true);
      }
    },
    [remoteConfig]
  );

  function updateBrand(brandId: string, updates: Partial<Pick<Brand, "name" | "active">>) {
    const timestamp = nowIso();
    const currentBrand = brands.find((brand) => brand.id === brandId);
    if (!currentBrand) {
      return;
    }

    const updatedBrand: Brand = {
      ...currentBrand,
      ...updates,
      updatedAt: timestamp
    };

    setBrands((prev) => prev.map((brand) => (brand.id === brandId ? updatedBrand : brand)));

    if (updatedBrand.showAlertActive || updatedBrand.frequentAlert) {
      void pushBrandAlertToRemote(updatedBrand);
    }
  }

  function sendShowAlert(brandId: string, message: string) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return;
    }

    const timestamp = nowIso();
    const currentBrand = brands.find((brand) => brand.id === brandId);
    if (!currentBrand) {
      return;
    }

    const updatedBrand: Brand = {
      ...currentBrand,
      showAlertActive: true,
      showAlertMessage: trimmedMessage,
      showAlertSentAt: timestamp,
      showAlertUpdatedAt: timestamp,
      updatedAt: timestamp
    };

    setBrands((prev) => prev.map((brand) => (brand.id === brandId ? updatedBrand : brand)));
    void pushBrandAlertToRemote(updatedBrand);
  }

  function clearShowAlert(brandId: string) {
    const timestamp = nowIso();
    const currentBrand = brands.find((brand) => brand.id === brandId);
    if (!currentBrand) {
      return;
    }

    const updatedBrand: Brand = {
      ...currentBrand,
      showAlertActive: false,
      showAlertUpdatedAt: timestamp,
      updatedAt: timestamp
    };

    setBrands((prev) => prev.map((brand) => (brand.id === brandId ? updatedBrand : brand)));
    void pushBrandAlertToRemote(updatedBrand);
  }

  function setBrandFrequentAlert(brandId: string, isFrequent: boolean) {
    const timestamp = nowIso();
    const currentBrand = brands.find((brand) => brand.id === brandId);
    if (!currentBrand) {
      return;
    }

    const updatedBrand: Brand = {
      ...currentBrand,
      frequentAlert: isFrequent,
      updatedAt: timestamp
    };

    setBrands((prev) => prev.map((brand) => (brand.id === brandId ? updatedBrand : brand)));
    void pushBrandAlertToRemote(updatedBrand);
  }

  function duplicateBrand(brandId: string) {
    const sourceBrand = brands.find((brand) => brand.id === brandId);
    if (!sourceBrand) {
      return;
    }

    const timestamp = nowIso();
    const duplicatedBrandId = newId("brand");

    setBrands((prev) => [
      ...prev,
      {
        ...sourceBrand,
        id: duplicatedBrandId,
        name: `${sourceBrand.name} (Copy)`,
        showAlertActive: false,
        showAlertMessage: "",
        showAlertSentAt: "",
        showAlertUpdatedAt: "",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]);

    const linesToCopy = ticketLines.filter((line) => line.brandId === brandId);

    setTicketLines((prev) => [
      ...prev,
      ...linesToCopy.map((line) => ({
        ...line,
        id: newId("line"),
        brandId: duplicatedBrandId,
        createdAt: timestamp,
        updatedAt: timestamp
      }))
    ]);
  }

  function deleteBrand(brandId: string) {
    setBrands((prev) => prev.filter((brand) => brand.id !== brandId));
    setTicketLines((prev) => prev.filter((line) => line.brandId !== brandId));
  }

  function addTicketLine(brandId: string, payload: AddTicketLinePayload) {
    const timestamp = nowIso();

    setTicketLines((prev) => {
      const nextSortOrder = prev
        .filter((line) => line.brandId === brandId)
        .reduce((maxSort, line) => Math.max(maxSort, line.sortOrder), 0) + 1;

      return [
        ...prev,
        {
          id: newId("line"),
          brandId,
          ticketLabel: payload.ticketLabel.trim(),
          qualifierText: payload.qualifierText.trim(),
          retailPrice: payload.retailPrice,
          cmaPrice: payload.cmaPrice,
          active: payload.active,
          sortOrder: nextSortOrder,
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ];
    });
  }

  function updateTicketLine(
    lineId: string,
    updates: Partial<Pick<TicketLine, "ticketLabel" | "qualifierText" | "retailPrice" | "cmaPrice" | "active">>
  ) {
    const timestamp = nowIso();

    setTicketLines((prev) =>
      prev.map((line) => {
        if (line.id !== lineId) {
          return line;
        }

        return {
          ...line,
          ...updates,
          updatedAt: timestamp
        };
      })
    );
  }

  function duplicateTicketLine(lineId: string) {
    const sourceLine = ticketLines.find((line) => line.id === lineId);
    if (!sourceLine) {
      return;
    }

    const timestamp = nowIso();

    setTicketLines((prev) => {
      const nextSortOrder = prev
        .filter((line) => line.brandId === sourceLine.brandId)
        .reduce((maxSort, line) => Math.max(maxSort, line.sortOrder), 0) + 1;

      return [
        ...prev,
        {
          ...sourceLine,
          id: newId("line"),
          ticketLabel: `${sourceLine.ticketLabel} (Copy)`,
          sortOrder: nextSortOrder,
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ];
    });
  }

  function deleteTicketLine(lineId: string) {
    setTicketLines((prev) => prev.filter((line) => line.id !== lineId));
  }

  function addAdminUser(name: string, emailOrLogin: string) {
    const trimmedName = name.trim();
    const trimmedEmail = emailOrLogin.trim();

    if (!trimmedName || !trimmedEmail) {
      return;
    }

    const timestamp = nowIso();

    setUsers((prev) => [
      ...prev,
      {
        id: newId("user"),
        name: trimmedName,
        emailOrLogin: trimmedEmail,
        role: "admin",
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]);
  }

  function toggleAdminActive(userId: string) {
    const timestamp = nowIso();

    setUsers((prev) =>
      prev.map((user) => {
        if (user.id !== userId || user.role !== "admin") {
          return user;
        }

        return {
          ...user,
          active: !user.active,
          updatedAt: timestamp
        };
      })
    );
  }

  const value = useMemo<AppDataContextValue>(
    () => ({
      users,
      brands,
      ticketLines,
      remoteConfig,
      remoteStatusMessage,
      remoteStatusIsError,
      remoteStatusAt,
      addBrand,
      updateBrand,
      sendShowAlert,
      clearShowAlert,
      setBrandFrequentAlert,
      updateRemoteConfig,
      syncRemoteAlerts,
      duplicateBrand,
      deleteBrand,
      addTicketLine,
      updateTicketLine,
      duplicateTicketLine,
      deleteTicketLine,
      addAdminUser,
      toggleAdminActive
    }),
    [
      users,
      brands,
      ticketLines,
      remoteConfig,
      remoteStatusMessage,
      remoteStatusIsError,
      remoteStatusAt,
      syncRemoteAlerts
    ]
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataContextValue {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error("useAppData must be used inside AppDataProvider");
  }
  return context;
}


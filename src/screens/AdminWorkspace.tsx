import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useAppData } from "../context/AppDataContext";
import { ActiveFilter, TicketLineDraft } from "../types";
import { formatMoney, parseCurrencyInput } from "../utils/pricing";

interface AdminWorkspaceProps {
  onSignOut: () => void;
}

type AdminTab = "alerts" | "brands" | "assistant" | "admins";

interface DraftExtractItem {
  brandName: string;
  ticketLabel: string;
  qualifierText: string;
  retailPrice: number;
  cmaPrice: number;
  source: string;
}

function filterByActive<T extends { active: boolean }>(items: T[], filter: ActiveFilter): T[] {
  if (filter === "active") {
    return items.filter((item) => item.active);
  }
  if (filter === "inactive") {
    return items.filter((item) => !item.active);
  }
  return items;
}

function emptyLineDraft(): TicketLineDraft {
  return {
    ticketLabel: "",
    qualifierText: "",
    retailPrice: "",
    cmaPrice: "",
    active: true
  };
}

function formatAlertTimestamp(timestamp: string): string {
  if (!timestamp) {
    return "Not sent yet";
  }

  const asDate = new Date(timestamp);
  if (!Number.isFinite(asDate.getTime())) {
    return "Not sent yet";
  }

  return asDate.toLocaleString();
}

export function AdminWorkspace({ onSignOut }: AdminWorkspaceProps) {
  const {
    users,
    brands,
    ticketLines,
    addBrand,
    updateBrand,
    duplicateBrand,
    deleteBrand,
    addTicketLine,
    updateTicketLine,
    duplicateTicketLine,
    deleteTicketLine,
    addAdminUser,
    toggleAdminActive,
    sendShowAlert,
    clearShowAlert,
    setBrandFrequentAlert,
    remoteConfig,
    remoteStatusMessage,
    remoteStatusIsError,
    remoteStatusAt,
    updateRemoteConfig,
    syncRemoteAlerts
  } = useAppData();

  const { width } = useWindowDimensions();

  const [tab, setTab] = useState<AdminTab>("alerts");
  const [brandFilter, setBrandFilter] = useState<ActiveFilter>("all");
  const [lineFilter, setLineFilter] = useState<ActiveFilter>("all");
  const [brandSearchTerm, setBrandSearchTerm] = useState("");
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [newBrandName, setNewBrandName] = useState("");
  const [brandNameDraft, setBrandNameDraft] = useState("");

  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState<TicketLineDraft>(emptyLineDraft());

  const [assistantInput, setAssistantInput] = useState("");
  const [assistantDraftPreview, setAssistantDraftPreview] = useState<DraftExtractItem[]>([]);

  const [newAdminName, setNewAdminName] = useState("");
  const [newAdminLogin, setNewAdminLogin] = useState("");

  const [alertSearchTerm, setAlertSearchTerm] = useState("");
  const [alertComposerBrandId, setAlertComposerBrandId] = useState<string | null>(null);
  const [alertDraftMessage, setAlertDraftMessage] = useState("");

  const isWide = width >= 1000;

  const sortedBrands = useMemo(() => [...brands].sort((a, b) => a.name.localeCompare(b.name)), [brands]);
  const filteredBrands = useMemo(() => {
    const byActive = filterByActive(sortedBrands, brandFilter);
    const query = brandSearchTerm.trim().toLowerCase();

    if (!query) {
      return byActive;
    }

    return byActive.filter((brand) => brand.name.toLowerCase().includes(query));
  }, [sortedBrands, brandFilter, brandSearchTerm]);

  const selectedBrand = useMemo(
    () => brands.find((brand) => brand.id === selectedBrandId) ?? null,
    [brands, selectedBrandId]
  );

  const selectedBrandLines = useMemo(() => {
    if (!selectedBrand) {
      return [];
    }

    return ticketLines
      .filter((line) => line.brandId === selectedBrand.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [selectedBrand, ticketLines]);

  const filteredBrandLines = useMemo(
    () => filterByActive(selectedBrandLines, lineFilter),
    [selectedBrandLines, lineFilter]
  );

  const adminUsers = useMemo(() => users.filter((user) => user.role === "admin"), [users]);
  const sortedAlertBrands = useMemo(() => [...brands].sort((a, b) => a.name.localeCompare(b.name)), [brands]);
  const frequentAlertBrands = useMemo(
    () => sortedAlertBrands.filter((brand) => brand.frequentAlert),
    [sortedAlertBrands]
  );
  const filteredAlertBrands = useMemo(() => {
    const query = alertSearchTerm.trim().toLowerCase();
    if (!query) {
      return sortedAlertBrands;
    }
    return sortedAlertBrands.filter((brand) => brand.name.toLowerCase().includes(query));
  }, [sortedAlertBrands, alertSearchTerm]);
  const alertComposerBrand = useMemo(
    () => brands.find((brand) => brand.id === alertComposerBrandId) ?? null,
    [brands, alertComposerBrandId]
  );
  const activeAlertCount = useMemo(
    () => brands.filter((brand) => brand.showAlertActive && brand.showAlertMessage.trim()).length,
    [brands]
  );

  useEffect(() => {
    if (!selectedBrandId && filteredBrands.length) {
      setSelectedBrandId(filteredBrands[0].id);
    }

    if (selectedBrandId && !brands.some((brand) => brand.id === selectedBrandId)) {
      setSelectedBrandId(filteredBrands.length ? filteredBrands[0].id : null);
    }
  }, [selectedBrandId, filteredBrands, brands]);

  useEffect(() => {
    setBrandNameDraft(selectedBrand?.name ?? "");
    setEditingLineId(null);
    setLineDraft(emptyLineDraft());
  }, [selectedBrand?.id]);

  function createBrand() {
    const trimmed = newBrandName.trim();
    if (!trimmed) {
      return;
    }

    addBrand(trimmed);
    setNewBrandName("");
  }

  function saveBrandName() {
    if (!selectedBrand) {
      return;
    }

    const trimmed = brandNameDraft.trim();
    if (!trimmed) {
      return;
    }

    updateBrand(selectedBrand.id, { name: trimmed });
  }

  function confirmDeleteBrand(brandId: string, brandName: string) {
    Alert.alert(
      "Delete Total",
      `Delete \"${brandName}\" and all ticket lines under it permanently?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Total",
          style: "destructive",
          onPress: () => deleteBrand(brandId)
        }
      ]
    );
  }

  function beginEditLine(lineId: string) {
    const line = selectedBrandLines.find((item) => item.id === lineId);
    if (!line) {
      return;
    }

    setEditingLineId(line.id);
    setLineDraft({
      ticketLabel: line.ticketLabel,
      qualifierText: line.qualifierText,
      retailPrice: formatMoney(line.retailPrice),
      cmaPrice: formatMoney(line.cmaPrice),
      active: line.active
    });
  }

  function resetLineEditor() {
    setEditingLineId(null);
    setLineDraft(emptyLineDraft());
  }

  function saveLine() {
    if (!selectedBrand) {
      return;
    }

    const ticketLabel = lineDraft.ticketLabel.trim();
    const retailPrice = parseCurrencyInput(lineDraft.retailPrice);
    const cmaPrice = parseCurrencyInput(lineDraft.cmaPrice);

    if (!ticketLabel) {
      Alert.alert("Missing Ticket Label", "Enter a ticket label before saving.");
      return;
    }

    if (retailPrice < 0 || cmaPrice < 0) {
      Alert.alert("Invalid Price", "Retail and CMA prices must be zero or higher.");
      return;
    }

    if (editingLineId) {
      updateTicketLine(editingLineId, {
        ticketLabel,
        qualifierText: lineDraft.qualifierText.trim(),
        retailPrice,
        cmaPrice,
        active: lineDraft.active
      });
      resetLineEditor();
      return;
    }

    addTicketLine(selectedBrand.id, {
      ticketLabel,
      qualifierText: lineDraft.qualifierText.trim(),
      retailPrice,
      cmaPrice,
      active: lineDraft.active
    });

    setLineDraft(emptyLineDraft());
  }

  function confirmDeleteLine(lineId: string, displayName: string) {
    Alert.alert("Delete Line", `Delete line \"${displayName}\" permanently?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete Line",
        style: "destructive",
        onPress: () => {
          deleteTicketLine(lineId);
          if (editingLineId === lineId) {
            resetLineEditor();
          }
        }
      }
    ]);
  }

  function prepareAssistantDraft() {
    const lines = assistantInput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const extracted: DraftExtractItem[] = [];

    for (const sourceLine of lines) {
      const csvParts = sourceLine.split(/[|,\t]/).map((part) => part.trim()).filter(Boolean);

      if (csvParts.length >= 4) {
        const [brandName, ticketLabel, retailRaw, cmaRaw] = csvParts;
        const retailPrice = parseCurrencyInput(retailRaw);
        const cmaPrice = parseCurrencyInput(cmaRaw);

        extracted.push({
          brandName,
          ticketLabel,
          qualifierText: "",
          retailPrice,
          cmaPrice,
          source: sourceLine
        });
        continue;
      }

      const match = sourceLine.match(/^(.*?)\s+-\s+(.*?)\s+-\s*\$?(\d+(?:\.\d{1,2})?)\s+-\s*\$?(\d+(?:\.\d{1,2})?)$/i);

      if (match) {
        extracted.push({
          brandName: match[1].trim(),
          ticketLabel: match[2].trim(),
          qualifierText: "",
          retailPrice: parseCurrencyInput(match[3]),
          cmaPrice: parseCurrencyInput(match[4]),
          source: sourceLine
        });
      }
    }

    setAssistantDraftPreview(extracted);
  }

  function openAlertComposer(brandId: string) {
    const selected = brands.find((item) => item.id === brandId);
    if (!selected) {
      return;
    }

    setAlertComposerBrandId(selected.id);
    setAlertDraftMessage(selected.showAlertMessage || "");
  }

  function closeAlertComposer() {
    setAlertComposerBrandId(null);
    setAlertDraftMessage("");
  }

  function onAlertCheckboxPress(brandId: string) {
    const selected = brands.find((item) => item.id === brandId);
    if (!selected) {
      return;
    }

    if (selected.showAlertActive) {
      Alert.alert(
        "Turn Alert Off",
        `Turn off the live alert for "${selected.name}"?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Turn Off",
            style: "destructive",
            onPress: () => {
              clearShowAlert(selected.id);
              if (alertComposerBrandId === selected.id) {
                closeAlertComposer();
              }
            }
          }
        ]
      );
      return;
    }

    openAlertComposer(selected.id);
  }

  function sendAlertFromComposer() {
    if (!alertComposerBrand) {
      return;
    }

    const trimmed = alertDraftMessage.trim();
    if (!trimmed) {
      Alert.alert("Missing Alert Details", "Enter availability details before sending this alert.");
      return;
    }

    sendShowAlert(alertComposerBrand.id, trimmed);
    closeAlertComposer();
  }

  function renderAlertBrandRow(brandId: string, compact = false) {
    const brand = brands.find((item) => item.id === brandId);
    if (!brand) {
      return null;
    }

    const statusText = brand.showAlertActive ? "Live Alert ON" : "No live alert";

    return (
      <View key={`${compact ? "frequent" : "all"}-${brand.id}`} style={[styles.alertBrandCard, compact ? styles.alertBrandCardCompact : undefined]}>
        <View style={styles.alertBrandHeader}>
          <Pressable
            style={[styles.checkboxBox, brand.showAlertActive ? styles.checkboxBoxActive : undefined]}
            onPress={() => onAlertCheckboxPress(brand.id)}
          >
            <Text style={[styles.checkboxTick, brand.showAlertActive ? styles.checkboxTickActive : undefined]}>
              {brand.showAlertActive ? "X" : ""}
            </Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.brandCardTitle}>{brand.name}</Text>
            <Text style={styles.statusText}>{statusText}</Text>
            <Text style={styles.alertStampText}>Last send: {formatAlertTimestamp(brand.showAlertSentAt)}</Text>
          </View>
        </View>

        {brand.showAlertMessage ? (
          <Text style={styles.alertPreviewText} numberOfLines={compact ? 2 : 3}>
            {brand.showAlertMessage}
          </Text>
        ) : (
          <Text style={styles.alertPreviewPlaceholder}>No alert note saved yet.</Text>
        )}

        <View style={styles.actionsRow}>
          <Pressable style={styles.miniButton} onPress={() => openAlertComposer(brand.id)}>
            <Text style={styles.miniButtonText}>{brand.showAlertActive ? "Edit / Resend" : "Write Alert"}</Text>
          </Pressable>

          <Pressable
            style={styles.miniButton}
            onPress={() => setBrandFrequentAlert(brand.id, !brand.frequentAlert)}
          >
            <Text style={styles.miniButtonText}>{brand.frequentAlert ? "Remove Frequent" : "Add Frequent"}</Text>
          </Pressable>

          {brand.showAlertActive ? (
            <Pressable style={[styles.miniButton, styles.miniDangerButton]} onPress={() => clearShowAlert(brand.id)}>
              <Text style={[styles.miniButtonText, styles.miniDangerText]}>Turn Off</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  function renderAlertsTab() {
    return (
      <View style={styles.tabContentWrap}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Cloud Alert Sync</Text>
          <Text style={styles.helperText}>Set this once so alerts broadcast to every tablet.</Text>
          <TextInput
            style={styles.input}
            value={remoteConfig.supabaseUrl}
            onChangeText={(value) => updateRemoteConfig({ supabaseUrl: value })}
            placeholder="Supabase URL (https://YOURPROJECT.supabase.co)"
            placeholderTextColor="#6a7c71"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={remoteConfig.anonKey}
            onChangeText={(value) => updateRemoteConfig({ anonKey: value })}
            placeholder="Anon Read Key"
            placeholderTextColor="#6a7c71"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <TextInput
            style={styles.input}
            value={remoteConfig.adminKey}
            onChangeText={(value) => updateRemoteConfig({ adminKey: value })}
            placeholder="Admin Write Key (service role)"
            placeholderTextColor="#6a7c71"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <TextInput
            style={styles.input}
            value={remoteConfig.alertsTable}
            onChangeText={(value) => updateRemoteConfig({ alertsTable: value })}
            placeholder="Alerts table name"
            placeholderTextColor="#6a7c71"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.actionsRow}>
            <Pressable style={styles.miniButton} onPress={() => updateRemoteConfig({ autoSync: !remoteConfig.autoSync })}>
              <Text style={styles.miniButtonText}>{remoteConfig.autoSync ? "Auto Sync ON" : "Auto Sync OFF"}</Text>
            </Pressable>
            <Pressable style={styles.primaryButton} onPress={() => void syncRemoteAlerts()}>
              <Text style={styles.primaryButtonLabel}>Sync Now</Text>
            </Pressable>
          </View>
          {remoteStatusMessage ? (
            <View style={[styles.remoteStatusCard, remoteStatusIsError ? styles.remoteStatusCardError : undefined]}>
              <Text style={[styles.remoteStatusText, remoteStatusIsError ? styles.remoteStatusTextError : undefined]}>
                {remoteStatusMessage}
              </Text>
              {remoteStatusAt ? <Text style={styles.remoteStatusStamp}>Updated: {formatAlertTimestamp(remoteStatusAt)}</Text> : null}
            </View>
          ) : null}

          <View style={styles.dividerLine} />
          <Text style={styles.panelTitle}>Show Alerts Broadcast</Text>
          <Text style={styles.helperText}>
            Tap the alert checkbox for a show, enter availability details, then send the update to marketers.
          </Text>
          <Text style={styles.helperText}>Live alerts right now: {activeAlertCount}</Text>

          <TextInput
            style={styles.input}
            value={alertSearchTerm}
            onChangeText={setAlertSearchTerm}
            placeholder="Search show name..."
            placeholderTextColor="#6a7c71"
          />

          <Text style={styles.sectionTitle}>Frequent Alerts Folder</Text>
          {!frequentAlertBrands.length ? (
            <Text style={styles.emptyText}>No frequent shows yet. Tap "Add Frequent" on any show below.</Text>
          ) : null}
          <View style={styles.alertFolderWrap}>
            {frequentAlertBrands.map((brand) => renderAlertBrandRow(brand.id, true))}
          </View>

          <Text style={styles.sectionTitle}>All Shows ({filteredAlertBrands.length})</Text>
          <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
            {filteredAlertBrands.map((brand) => renderAlertBrandRow(brand.id))}
            {!filteredAlertBrands.length ? <Text style={styles.emptyText}>No shows match this search.</Text> : null}
          </ScrollView>
        </View>

        {alertComposerBrand ? (
          <View style={styles.alertComposerOverlay}>
            <View style={styles.alertComposerCard}>
              <Text style={styles.panelTitle}>Alert Info Box</Text>
              <Text style={styles.helperText}>{alertComposerBrand.name}</Text>
              <Text style={styles.helperText}>Type availability updates (sold out / open dates / notes), then send.</Text>

              <TextInput
                style={styles.alertComposerInput}
                multiline
                value={alertDraftMessage}
                onChangeText={setAlertDraftMessage}
                placeholder={"Example:\nSold Out: Fri 7 PM\nAvailable: Sat 5 PM + 8 PM\nNotes: Arrive 30 mins early."}
                placeholderTextColor="#6a7c71"
              />

              <View style={styles.actionsRow}>
                <Pressable style={styles.primaryButton} onPress={sendAlertFromComposer}>
                  <Text style={styles.primaryButtonLabel}>Send Alert</Text>
                </Pressable>
                <Pressable style={styles.miniButton} onPress={closeAlertComposer}>
                  <Text style={styles.miniButtonText}>Cancel</Text>
                </Pressable>
                {alertComposerBrand.showAlertActive ? (
                  <Pressable
                    style={[styles.miniButton, styles.miniDangerButton]}
                    onPress={() => {
                      clearShowAlert(alertComposerBrand.id);
                      closeAlertComposer();
                    }}
                  >
                    <Text style={[styles.miniButtonText, styles.miniDangerText]}>Turn Alert Off</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  function renderBrandsTab() {
    return (
      <View style={[styles.tabContentWrap, isWide ? styles.tabContentWide : undefined]}>
        <View style={[styles.panel, isWide ? styles.brandsPanelWide : undefined]}>
          <Text style={styles.panelTitle}>Brands</Text>
          <View style={styles.filterRow}>
            {(["all", "active", "inactive"] as ActiveFilter[]).map((item) => (
              <Pressable
                key={item}
                style={[styles.filterButton, brandFilter === item ? styles.filterButtonActive : undefined]}
                onPress={() => setBrandFilter(item)}
              >
                <Text style={[styles.filterLabel, brandFilter === item ? styles.filterLabelActive : undefined]}>{item}</Text>
              </Pressable>
            ))}
          </View>

          <TextInput
            style={styles.input}
            value={brandSearchTerm}
            onChangeText={setBrandSearchTerm}
            placeholder="Search brands..."
            placeholderTextColor="#6a7c71"
          />

          <View style={styles.newBrandRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={newBrandName}
              onChangeText={setNewBrandName}
              placeholder="New brand name"
              placeholderTextColor="#6a7c71"
            />
            <Pressable style={styles.primaryButton} onPress={createBrand}>
              <Text style={styles.primaryButtonLabel}>Add Brand</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
            {filteredBrands.map((brand) => (
              <View key={brand.id} style={styles.brandCard}>
                <Pressable onPress={() => setSelectedBrandId(brand.id)}>
                  <Text style={styles.brandCardTitle}>{brand.name}</Text>
                </Pressable>
                <Text style={styles.statusText}>{brand.active ? "Active" : "Inactive"}</Text>

                <View style={styles.actionsRow}>
                  <Pressable
                    style={styles.miniButton}
                    onPress={() => setSelectedBrandId(brand.id)}
                  >
                    <Text style={styles.miniButtonText}>Open</Text>
                  </Pressable>

                  <Pressable style={styles.miniButton} onPress={() => duplicateBrand(brand.id)}>
                    <Text style={styles.miniButtonText}>Duplicate</Text>
                  </Pressable>

                  <Pressable
                    style={styles.miniButton}
                    onPress={() => updateBrand(brand.id, { active: !brand.active })}
                  >
                    <Text style={styles.miniButtonText}>{brand.active ? "Inactivate" : "Activate"}</Text>
                  </Pressable>

                  <Pressable
                    style={[styles.miniButton, styles.miniDangerButton]}
                    onPress={() => confirmDeleteBrand(brand.id, brand.name)}
                  >
                    <Text style={[styles.miniButtonText, styles.miniDangerText]}>Delete Total</Text>
                  </Pressable>
                </View>
              </View>
            ))}

            {!filteredBrands.length ? <Text style={styles.emptyText}>No brands for this filter.</Text> : null}
          </ScrollView>
        </View>

        <View style={[styles.panel, isWide ? styles.detailPanelWide : undefined]}>
          <Text style={styles.panelTitle}>Brand Detail</Text>
          {!selectedBrand ? <Text style={styles.emptyText}>Select a brand to manage ticket lines.</Text> : null}

          {selectedBrand ? (
            <>
              <View style={styles.editBrandRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={brandNameDraft}
                  onChangeText={setBrandNameDraft}
                  placeholder="Brand name"
                  placeholderTextColor="#6a7c71"
                />
                <Pressable style={styles.primaryButton} onPress={saveBrandName}>
                  <Text style={styles.primaryButtonLabel}>Save</Text>
                </Pressable>
              </View>

              <View style={styles.filterRow}>
                {(["all", "active", "inactive"] as ActiveFilter[]).map((item) => (
                  <Pressable
                    key={item}
                    style={[styles.filterButton, lineFilter === item ? styles.filterButtonActive : undefined]}
                    onPress={() => setLineFilter(item)}
                  >
                    <Text style={[styles.filterLabel, lineFilter === item ? styles.filterLabelActive : undefined]}>{item}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.sectionTitle}>{editingLineId ? "Edit Ticket Line" : "Add Ticket Line"}</Text>
              <View style={styles.formGrid}>
                <TextInput
                  style={styles.input}
                  value={lineDraft.ticketLabel}
                  onChangeText={(value) => setLineDraft((prev) => ({ ...prev, ticketLabel: value }))}
                  placeholder="Ticket label (Adult, VIP, etc.)"
                  placeholderTextColor="#6a7c71"
                />
                <TextInput
                  style={styles.input}
                  value={lineDraft.qualifierText}
                  onChangeText={(value) => setLineDraft((prev) => ({ ...prev, qualifierText: value }))}
                  placeholder="Qualifier (12+, 48in+, etc.)"
                  placeholderTextColor="#6a7c71"
                />
                <TextInput
                  style={styles.input}
                  value={lineDraft.retailPrice}
                  onChangeText={(value) => setLineDraft((prev) => ({ ...prev, retailPrice: value }))}
                  keyboardType="decimal-pad"
                  placeholder="Retail price"
                  placeholderTextColor="#6a7c71"
                />
                <TextInput
                  style={styles.input}
                  value={lineDraft.cmaPrice}
                  onChangeText={(value) => setLineDraft((prev) => ({ ...prev, cmaPrice: value }))}
                  keyboardType="decimal-pad"
                  placeholder="CMA price"
                  placeholderTextColor="#6a7c71"
                />
              </View>

              <View style={styles.actionsRow}>
                <Pressable
                  style={styles.miniButton}
                  onPress={() => setLineDraft((prev) => ({ ...prev, active: !prev.active }))}
                >
                  <Text style={styles.miniButtonText}>{lineDraft.active ? "Set Inactive" : "Set Active"}</Text>
                </Pressable>

                <Pressable style={styles.primaryButton} onPress={saveLine}>
                  <Text style={styles.primaryButtonLabel}>{editingLineId ? "Update Line" : "Add Line"}</Text>
                </Pressable>

                {editingLineId ? (
                  <Pressable style={styles.miniButton} onPress={resetLineEditor}>
                    <Text style={styles.miniButtonText}>Cancel Edit</Text>
                  </Pressable>
                ) : null}
              </View>

              <Text style={styles.sectionTitle}>Ticket Lines ({filteredBrandLines.length})</Text>
              <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
                {filteredBrandLines.map((line) => {
                  const displayName = line.qualifierText ? `${line.ticketLabel} ${line.qualifierText}` : line.ticketLabel;

                  return (
                    <View key={line.id} style={styles.lineCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.lineTitle}>{displayName}</Text>
                        <Text style={styles.lineMeta}>Retail ${formatMoney(line.retailPrice)} | CMA ${formatMoney(line.cmaPrice)}</Text>
                        <Text style={styles.statusText}>{line.active ? "Active" : "Inactive"}</Text>
                      </View>

                      <View style={styles.actionsColumn}>
                        <Pressable style={styles.miniButton} onPress={() => beginEditLine(line.id)}>
                          <Text style={styles.miniButtonText}>Edit</Text>
                        </Pressable>

                        <Pressable style={styles.miniButton} onPress={() => duplicateTicketLine(line.id)}>
                          <Text style={styles.miniButtonText}>Duplicate</Text>
                        </Pressable>

                        <Pressable
                          style={styles.miniButton}
                          onPress={() => updateTicketLine(line.id, { active: !line.active })}
                        >
                          <Text style={styles.miniButtonText}>{line.active ? "Inactivate" : "Activate"}</Text>
                        </Pressable>

                        <Pressable
                          style={[styles.miniButton, styles.miniDangerButton]}
                          onPress={() => confirmDeleteLine(line.id, displayName)}
                        >
                          <Text style={[styles.miniButtonText, styles.miniDangerText]}>Delete Line</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}

                {!filteredBrandLines.length ? <Text style={styles.emptyText}>No ticket lines for this filter.</Text> : null}
              </ScrollView>
            </>
          ) : null}
        </View>
      </View>
    );
  }

  function renderAssistantTab() {
    return (
      <View style={styles.tabContentWrap}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Assistant Import / Review (Placeholder)</Text>
          <Text style={styles.helperText}>
            Paste spreadsheet rows or OCR text below, then generate a draft extraction for admin review before final save.
          </Text>

          <TextInput
            style={styles.multilineInput}
            multiline
            value={assistantInput}
            onChangeText={setAssistantInput}
            placeholder={"Examples:\nMedieval Times,Adult 12+,89.99,74.50\nCarolina Opry - Premium - 69.00 - 55.00"}
            placeholderTextColor="#6a7c71"
          />

          <Pressable style={styles.primaryButton} onPress={prepareAssistantDraft}>
            <Text style={styles.primaryButtonLabel}>Prepare Draft Extraction</Text>
          </Pressable>

          <Text style={styles.sectionTitle}>Draft Preview ({assistantDraftPreview.length})</Text>
          {!assistantDraftPreview.length ? (
            <Text style={styles.emptyText}>No draft rows yet. This screen is intentionally review-first.</Text>
          ) : null}

          <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
            {assistantDraftPreview.map((row, idx) => (
              <View key={`${row.brandName}-${idx}`} style={styles.lineCard}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.lineTitle}>{row.brandName}</Text>
                  <Text style={styles.lineMeta}>
                    {row.ticketLabel}
                    {row.qualifierText ? ` ${row.qualifierText}` : ""}
                  </Text>
                  <Text style={styles.lineMeta}>
                    Retail ${formatMoney(row.retailPrice)} | CMA ${formatMoney(row.cmaPrice)}
                  </Text>
                  <Text style={styles.sourceMeta}>Source: {row.source}</Text>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    );
  }

  function renderAdminsTab() {
    return (
      <View style={styles.tabContentWrap}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Admin User Management</Text>
          <Text style={styles.helperText}>Add and enable/disable admin users.</Text>

          <View style={styles.formGrid}>
            <TextInput
              style={styles.input}
              value={newAdminName}
              onChangeText={setNewAdminName}
              placeholder="Admin name"
              placeholderTextColor="#6a7c71"
            />
            <TextInput
              style={styles.input}
              value={newAdminLogin}
              onChangeText={setNewAdminLogin}
              placeholder="Email or login"
              placeholderTextColor="#6a7c71"
            />
          </View>

          <Pressable
            style={styles.primaryButton}
            onPress={() => {
              addAdminUser(newAdminName, newAdminLogin);
              setNewAdminName("");
              setNewAdminLogin("");
            }}
          >
            <Text style={styles.primaryButtonLabel}>Add Admin</Text>
          </Pressable>

          <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
            {adminUsers.map((admin) => (
              <View key={admin.id} style={styles.brandCard}>
                <Text style={styles.brandCardTitle}>{admin.name}</Text>
                <Text style={styles.lineMeta}>{admin.emailOrLogin}</Text>
                <Text style={styles.statusText}>{admin.active ? "Active" : "Inactive"}</Text>

                <Pressable style={styles.miniButton} onPress={() => toggleAdminActive(admin.id)}>
                  <Text style={styles.miniButtonText}>{admin.active ? "Set Inactive" : "Set Active"}</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.screenTitle}>Admin Control</Text>
          <Text style={styles.screenSubtitle}>Show alerts, brands, ticket lines, statuses, admins, and import review.</Text>
        </View>
        <Pressable style={styles.signOutButton} onPress={onSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>
      </View>

      <View style={styles.tabsRow}>
        <Pressable style={[styles.tabButton, tab === "alerts" ? styles.tabButtonActive : undefined]} onPress={() => setTab("alerts")}>
          <Text style={[styles.tabLabel, tab === "alerts" ? styles.tabLabelActive : undefined]}>Show Alerts</Text>
        </Pressable>
        <Pressable style={[styles.tabButton, tab === "brands" ? styles.tabButtonActive : undefined]} onPress={() => setTab("brands")}>
          <Text style={[styles.tabLabel, tab === "brands" ? styles.tabLabelActive : undefined]}>Brands + Lines</Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, tab === "assistant" ? styles.tabButtonActive : undefined]}
          onPress={() => setTab("assistant")}
        >
          <Text style={[styles.tabLabel, tab === "assistant" ? styles.tabLabelActive : undefined]}>Assistant Review</Text>
        </Pressable>
        <Pressable style={[styles.tabButton, tab === "admins" ? styles.tabButtonActive : undefined]} onPress={() => setTab("admins")}>
          <Text style={[styles.tabLabel, tab === "admins" ? styles.tabLabelActive : undefined]}>Admins</Text>
        </Pressable>
      </View>

      {tab === "alerts" ? renderAlertsTab() : null}
      {tab === "brands" ? renderBrandsTab() : null}
      {tab === "assistant" ? renderAssistantTab() : null}
      {tab === "admins" ? renderAdminsTab() : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f1f5fa",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10
  },
  topBar: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d6deea",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  screenTitle: {
    fontSize: 21,
    fontWeight: "700",
    color: "#1a2a45"
  },
  screenSubtitle: {
    marginTop: 4,
    color: "#4f607d",
    fontSize: 13
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: "#c2cfdf",
    backgroundColor: "#edf3fb",
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  signOutText: {
    color: "#2d425d",
    fontWeight: "700"
  },
  tabsRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap"
  },
  tabButton: {
    borderWidth: 1,
    borderColor: "#c4d1e3",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#edf3fb"
  },
  tabButtonActive: {
    backgroundColor: "#dce9f8",
    borderColor: "#95b2d3"
  },
  tabLabel: {
    color: "#425a78",
    fontWeight: "600"
  },
  tabLabelActive: {
    color: "#1f3957",
    fontWeight: "700"
  },
  tabContentWrap: {
    flex: 1,
    position: "relative"
  },
  tabContentWide: {
    flexDirection: "row",
    gap: 10
  },
  panel: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d6deea",
    borderRadius: 14,
    padding: 12,
    gap: 8
  },
  brandsPanelWide: {
    flex: 1
  },
  detailPanelWide: {
    flex: 1.35
  },
  panelTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#1f3555"
  },
  sectionTitle: {
    marginTop: 6,
    fontSize: 15,
    fontWeight: "700",
    color: "#2d4668"
  },
  helperText: {
    color: "#5b6f8f",
    fontSize: 13
  },
  dividerLine: {
    borderTopWidth: 1,
    borderTopColor: "#d8e1ee",
    marginVertical: 2
  },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap"
  },
  filterButton: {
    borderWidth: 1,
    borderColor: "#c7d5e6",
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
    backgroundColor: "#f2f7fd"
  },
  filterButtonActive: {
    borderColor: "#89a8cc",
    backgroundColor: "#dfeaf8"
  },
  filterLabel: {
    color: "#4a607d",
    fontWeight: "600",
    textTransform: "capitalize"
  },
  filterLabelActive: {
    color: "#264261",
    fontWeight: "700"
  },
  newBrandRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center"
  },
  editBrandRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center"
  },
  input: {
    borderWidth: 1,
    borderColor: "#c1cfdf",
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: "#1e3351",
    backgroundColor: "#fafdff"
  },
  multilineInput: {
    borderWidth: 1,
    borderColor: "#c1cfdf",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 140,
    textAlignVertical: "top",
    color: "#1e3351",
    backgroundColor: "#fafdff"
  },
  primaryButton: {
    borderWidth: 1,
    borderColor: "#87a7cb",
    borderRadius: 9,
    backgroundColor: "#dbe8f7",
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: "flex-start"
  },
  primaryButtonLabel: {
    color: "#1f3d61",
    fontWeight: "700"
  },
  listScroll: {
    flex: 1,
    minHeight: 140
  },
  listContent: {
    gap: 8,
    paddingBottom: 4
  },
  brandCard: {
    borderWidth: 1,
    borderColor: "#cdd9e9",
    borderRadius: 10,
    backgroundColor: "#f8fbff",
    padding: 10,
    gap: 5
  },
  brandCardTitle: {
    fontWeight: "700",
    color: "#1f3859",
    fontSize: 15
  },
  statusText: {
    color: "#4f6585",
    fontSize: 12,
    fontWeight: "600"
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center"
  },
  actionsColumn: {
    gap: 6,
    alignItems: "flex-end"
  },
  miniButton: {
    borderWidth: 1,
    borderColor: "#b9c9de",
    borderRadius: 8,
    backgroundColor: "#eaf1fa",
    paddingHorizontal: 8,
    paddingVertical: 6
  },
  miniButtonText: {
    color: "#345171",
    fontSize: 12,
    fontWeight: "700"
  },
  miniDangerButton: {
    borderColor: "#dcb4b4",
    backgroundColor: "#fff1f1"
  },
  miniDangerText: {
    color: "#813e3e"
  },
  formGrid: {
    gap: 8
  },
  lineCard: {
    borderWidth: 1,
    borderColor: "#cad8ea",
    borderRadius: 10,
    backgroundColor: "#fbfdff",
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8
  },
  lineTitle: {
    color: "#1d3758",
    fontWeight: "700"
  },
  lineMeta: {
    color: "#577091",
    marginTop: 2,
    fontSize: 12
  },
  sourceMeta: {
    color: "#697f9f",
    marginTop: 3,
    fontSize: 11,
    fontStyle: "italic"
  },
  remoteStatusCard: {
    borderWidth: 1,
    borderColor: "#b8d4c2",
    backgroundColor: "#eef9f1",
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 8,
    gap: 3
  },
  remoteStatusCardError: {
    borderColor: "#dfb5b5",
    backgroundColor: "#fff2f2"
  },
  remoteStatusText: {
    color: "#255f38",
    fontSize: 12,
    fontWeight: "600"
  },
  remoteStatusTextError: {
    color: "#7f3b3b"
  },
  remoteStatusStamp: {
    color: "#617893",
    fontSize: 11
  },
  alertFolderWrap: {
    gap: 8
  },
  alertBrandCard: {
    borderWidth: 1,
    borderColor: "#d7dfea",
    borderRadius: 10,
    backgroundColor: "#fbfdff",
    padding: 10,
    gap: 8
  },
  alertBrandCardCompact: {
    backgroundColor: "#f7fbff"
  },
  alertBrandHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8
  },
  checkboxBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#aebed5",
    backgroundColor: "#f7faff",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1
  },
  checkboxBoxActive: {
    borderColor: "#8b3f3f",
    backgroundColor: "#ffe8e8"
  },
  checkboxTick: {
    color: "transparent",
    fontSize: 14,
    fontWeight: "700"
  },
  checkboxTickActive: {
    color: "#8b3f3f"
  },
  alertStampText: {
    color: "#677a97",
    fontSize: 11,
    marginTop: 2
  },
  alertPreviewText: {
    borderWidth: 1,
    borderColor: "#e3c3c3",
    backgroundColor: "#fff6f6",
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 8,
    color: "#6f3838",
    fontSize: 12
  },
  alertPreviewPlaceholder: {
    borderWidth: 1,
    borderColor: "#d4dfec",
    backgroundColor: "#f7fbff",
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 8,
    color: "#6b7f9a",
    fontSize: 12,
    fontStyle: "italic"
  },
  alertComposerOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(20,34,53,0.25)",
    justifyContent: "center",
    padding: 14
  },
  alertComposerCard: {
    borderWidth: 1,
    borderColor: "#d5a5a5",
    borderRadius: 12,
    backgroundColor: "#fffdfd",
    padding: 12,
    gap: 8
  },
  alertComposerInput: {
    borderWidth: 1,
    borderColor: "#d7b7b7",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 150,
    textAlignVertical: "top",
    color: "#4f2424",
    backgroundColor: "#fff9f9"
  },
  emptyText: {
    color: "#6f7f96",
    fontStyle: "italic"
  }
});


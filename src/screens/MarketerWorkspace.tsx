import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useAppData } from "../context/AppDataContext";
import { CartLine } from "../types";
import {
  calculateTwoWayTotals,
  cartGuestStartingTotal,
  cartRetailGrandTotal,
  formatMoney,
  lineCmaTotal,
  lineRetailTotal,
  mapLineToCart,
  parsePositiveIntegerInput
} from "../utils/pricing";

interface MarketerWorkspaceProps {
  onSignOut: () => void;
}

function asMoney(value: number): string {
  return `$${formatMoney(value)}`;
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

function makeCartLineId(): string {
  return `cart-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

export function MarketerWorkspace({ onSignOut }: MarketerWorkspaceProps) {
  const {
    brands,
    ticketLines,
    remoteConfig,
    remoteStatusMessage,
    remoteStatusIsError,
    remoteStatusAt,
    updateRemoteConfig,
    syncRemoteAlerts
  } = useAppData();
  const { width } = useWindowDimensions();

  const [searchTerm, setSearchTerm] = useState("");
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [cartLines, setCartLines] = useState<CartLine[]>([]);
  const [contributionInput, setContributionInput] = useState("0.00");
  const [guestFinalInput, setGuestFinalInput] = useState("0.00");
  const [lastEdited, setLastEdited] = useState<"contribution" | "guestFinal">("contribution");

  const isWide = width >= 920;

  const activeBrands = useMemo(
    () => brands.filter((brand) => brand.active).sort((a, b) => a.name.localeCompare(b.name)),
    [brands]
  );

  const searchResults = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (query.length < 3) {
      return [];
    }
    return activeBrands.filter((brand) => brand.name.toLowerCase().includes(query));
  }, [activeBrands, searchTerm]);

  const selectedBrand = useMemo(
    () => activeBrands.find((brand) => brand.id === selectedBrandId) ?? null,
    [activeBrands, selectedBrandId]
  );

  const selectedBrandLines = useMemo(() => {
    if (!selectedBrand) {
      return [];
    }

    return ticketLines
      .filter((line) => line.brandId === selectedBrand.id && line.active)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [selectedBrand, ticketLines]);

  const activeShowAlerts = useMemo(
    () =>
      brands
        .filter((brand) => brand.showAlertActive && brand.showAlertMessage.trim())
        .sort((a, b) => a.name.localeCompare(b.name)),
    [brands]
  );

  useEffect(() => {
    if (selectedBrandId && !activeBrands.some((brand) => brand.id === selectedBrandId)) {
      setSelectedBrandId(null);
    }
  }, [activeBrands, selectedBrandId]);

  const retailGrandTotal = useMemo(() => cartRetailGrandTotal(cartLines), [cartLines]);
  const guestStartingTotal = useMemo(() => cartGuestStartingTotal(cartLines), [cartLines]);

  const totals = useMemo(
    () =>
      calculateTwoWayTotals({
        guestStartingTotal,
        contributionInput,
        guestFinalInput,
        lastEdited
      }),
    [guestStartingTotal, contributionInput, guestFinalInput, lastEdited]
  );

  useEffect(() => {
    const normalizedContribution = formatMoney(totals.marketerContribution);
    const normalizedGuestFinal = formatMoney(totals.guestFinalTotal);

    if (lastEdited === "contribution" && guestFinalInput !== normalizedGuestFinal) {
      setGuestFinalInput(normalizedGuestFinal);
    }

    if (lastEdited === "guestFinal" && contributionInput !== normalizedContribution) {
      setContributionInput(normalizedContribution);
    }

    if (cartLines.length === 0) {
      if (contributionInput !== "0.00") {
        setContributionInput("0.00");
      }
      if (guestFinalInput !== "0.00") {
        setGuestFinalInput("0.00");
      }
    }
  }, [
    totals.marketerContribution,
    totals.guestFinalTotal,
    lastEdited,
    guestFinalInput,
    contributionInput,
    cartLines.length
  ]);

  const guardrailText = useMemo(() => {
    if (totals.contributionWasClamped) {
      return "Contribution was capped to match Guest Starting Total.";
    }
    if (totals.guestFinalWasClamped) {
      return "Guest Final Total was limited between $0.00 and Guest Starting Total.";
    }
    return "";
  }, [totals.contributionWasClamped, totals.guestFinalWasClamped]);

  function addLineToCart(ticketLineId: string) {
    if (!selectedBrand) {
      return;
    }

    const line = selectedBrandLines.find((item) => item.id === ticketLineId);
    if (!line) {
      return;
    }

    setCartLines((prev) => {
      const existing = prev.find((item) => item.ticketLineId === line.id && item.brandId === line.brandId);

      if (existing) {
        return prev.map((item) =>
          item.id === existing.id
            ? {
                ...item,
                qty: item.qty + 1
              }
            : item
        );
      }

      const base = mapLineToCart(selectedBrand.name, line);
      return [...prev, { ...base, id: makeCartLineId(), qty: 1 }];
    });
  }

  function updateQty(lineId: string, rawValue: string) {
    const nextQty = parsePositiveIntegerInput(rawValue, 1);

    setCartLines((prev) =>
      prev.map((line) => {
        if (line.id !== lineId) {
          return line;
        }
        return {
          ...line,
          qty: nextQty
        };
      })
    );
  }

  function changeQty(lineId: string, delta: number) {
    setCartLines((prev) =>
      prev.map((line) => {
        if (line.id !== lineId) {
          return line;
        }

        const nextQty = line.qty + delta;
        if (nextQty < 1) {
          return line;
        }

        return {
          ...line,
          qty: nextQty
        };
      })
    );
  }

  function removeCartLine(lineId: string) {
    setCartLines((prev) => prev.filter((line) => line.id !== lineId));
  }

  function clearCart() {
    if (!cartLines.length) {
      return;
    }

    Alert.alert("Clear All Cart Lines", "Remove every ticket line from this quote?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear All",
        style: "destructive",
        onPress: () => {
          setCartLines([]);
        }
      }
    ]);
  }

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.screenTitle}>Marketer Quote Builder</Text>
          <Text style={styles.screenSubtitle}>Search active brands, add ticket lines, and build quote totals live.</Text>
        </View>
        <Pressable style={styles.signOutButton} onPress={onSignOut}>
          <Text style={styles.signOutLabel}>Sign Out</Text>
        </Pressable>
      </View>

      <View style={styles.remotePanel}>
        <Text style={styles.remotePanelTitle}>Tablet Alert Sync</Text>
        <TextInput
          style={styles.input}
          value={remoteConfig.supabaseUrl}
          onChangeText={(value) => updateRemoteConfig({ supabaseUrl: value })}
          placeholder="Supabase URL"
          placeholderTextColor="#6f7f76"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          style={styles.input}
          value={remoteConfig.anonKey}
          onChangeText={(value) => updateRemoteConfig({ anonKey: value })}
          placeholder="Anon Read Key"
          placeholderTextColor="#6f7f76"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <TextInput
          style={styles.input}
          value={remoteConfig.alertsTable}
          onChangeText={(value) => updateRemoteConfig({ alertsTable: value })}
          placeholder="Alerts table"
          placeholderTextColor="#6f7f76"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.actionsInline}>
          <Pressable style={styles.smallActionButton} onPress={() => updateRemoteConfig({ autoSync: !remoteConfig.autoSync })}>
            <Text style={styles.smallActionText}>{remoteConfig.autoSync ? "Auto Sync ON" : "Auto Sync OFF"}</Text>
          </Pressable>
          <Pressable style={styles.smallActionButton} onPress={() => void syncRemoteAlerts()}>
            <Text style={styles.smallActionText}>Sync Now</Text>
          </Pressable>
        </View>
        {remoteStatusMessage ? (
          <View style={[styles.remoteStatusBox, remoteStatusIsError ? styles.remoteStatusBoxError : undefined]}>
            <Text style={[styles.remoteStatusLabel, remoteStatusIsError ? styles.remoteStatusLabelError : undefined]}>
              {remoteStatusMessage}
            </Text>
            {remoteStatusAt ? <Text style={styles.remoteStatusStamp}>Updated: {formatAlertTimestamp(remoteStatusAt)}</Text> : null}
          </View>
        ) : null}
      </View>

      {activeShowAlerts.length ? (
        <View style={styles.alertInfoBar}>
          <Text style={styles.alertInfoTitle}>Live Show Alerts ({activeShowAlerts.length})</Text>
          <ScrollView style={styles.alertInfoList} contentContainerStyle={styles.listContent}>
            {activeShowAlerts.map((brand) => (
              <Pressable
                key={`alert-${brand.id}`}
                style={styles.alertInfoRow}
                onPress={() => {
                  setSelectedBrandId(brand.id);
                  setSearchTerm(brand.name);
                }}
              >
                <Text style={styles.alertInfoBrand}>{brand.name}</Text>
                <Text style={styles.alertInfoMessage} numberOfLines={2}>
                  {brand.showAlertMessage}
                </Text>
                <Text style={styles.alertInfoStamp}>Updated: {formatAlertTimestamp(brand.showAlertSentAt)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={[styles.mainWrap, isWide ? styles.mainWrapWide : undefined]}>
        <View style={[styles.panel, isWide ? styles.leftPanel : undefined]}>
          <Text style={styles.panelTitle}>Brand Search</Text>
          <TextInput
            style={styles.input}
            value={searchTerm}
            onChangeText={setSearchTerm}
            placeholder="Type brand name (3+ letters)..."
            placeholderTextColor="#6f7f76"
          />

          {searchTerm.trim().length < 3 ? (
            <Text style={styles.helperText}>Start with at least 3 letters to show results.</Text>
          ) : null}

          <ScrollView style={styles.searchList} contentContainerStyle={styles.listContent}>
            {searchResults.map((brand) => (
              <Pressable
                key={brand.id}
                style={[styles.brandRow, selectedBrandId === brand.id ? styles.brandRowActive : undefined]}
                onPress={() => setSelectedBrandId(brand.id)}
              >
                <Text style={styles.brandRowText}>{brand.name}</Text>
              </Pressable>
            ))}

            {!searchResults.length && searchTerm.trim().length >= 3 ? (
              <Text style={styles.emptyHint}>No active brand matches this search.</Text>
            ) : null}
          </ScrollView>

          <View style={styles.divider} />

          <Text style={styles.panelTitle}>Ticket Lines</Text>
          {!selectedBrand ? (
            <Text style={styles.helperText}>Select a brand above to load active ticket lines.</Text>
          ) : null}

          {selectedBrand ? (
            <>
              <Text style={styles.selectedBrandLabel}>{selectedBrand.name}</Text>
              {selectedBrand.showAlertActive && selectedBrand.showAlertMessage.trim() ? (
                <View style={styles.selectedBrandAlertCard}>
                  <Text style={styles.selectedBrandAlertTitle}>Availability Alert</Text>
                  <Text style={styles.selectedBrandAlertBody}>{selectedBrand.showAlertMessage}</Text>
                  <Text style={styles.selectedBrandAlertStamp}>
                    Updated: {formatAlertTimestamp(selectedBrand.showAlertSentAt)}
                  </Text>
                </View>
              ) : null}
              <ScrollView style={styles.lineList} contentContainerStyle={styles.listContent}>
                {selectedBrandLines.map((line) => (
                  <View key={line.id} style={styles.lineRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.lineTitle}>
                        {line.qualifierText ? `${line.ticketLabel} ${line.qualifierText}` : line.ticketLabel}
                      </Text>
                      <Text style={styles.lineMeta}>Retail {asMoney(line.retailPrice)} | CMA {asMoney(line.cmaPrice)}</Text>
                    </View>
                    <Pressable style={styles.addButton} onPress={() => addLineToCart(line.id)}>
                      <Text style={styles.addButtonLabel}>Add</Text>
                    </Pressable>
                  </View>
                ))}

                {!selectedBrandLines.length ? (
                  <Text style={styles.emptyHint}>No active ticket lines under this brand.</Text>
                ) : null}
              </ScrollView>
            </>
          ) : null}
        </View>

        <View style={[styles.panel, isWide ? styles.rightPanel : undefined]}>
          <View style={styles.cartHeader}>
            <Text style={styles.panelTitle}>Cart</Text>
            <Pressable style={styles.clearButton} onPress={clearCart}>
              <Text style={styles.clearButtonLabel}>Clear All</Text>
            </Pressable>
          </View>

          {!cartLines.length ? <Text style={styles.helperText}>Cart is empty. Add ticket lines to begin.</Text> : null}

          <ScrollView style={styles.cartList} contentContainerStyle={styles.listContent}>
            {cartLines.map((line) => (
              <View key={line.id} style={styles.cartRow}>
                <View style={styles.cartRowTop}>
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    <Text style={styles.cartLineBrand}>{line.brandName}</Text>
                    <Text style={styles.cartLineType}>{line.ticketDisplayText}</Text>
                  </View>
                  <Pressable style={styles.removeButton} onPress={() => removeCartLine(line.id)}>
                    <Text style={styles.removeButtonLabel}>Remove</Text>
                  </Pressable>
                </View>

                <View style={styles.qtyWrap}>
                  <Text style={styles.qtyLabel}>Qty</Text>
                  <Pressable
                    style={[styles.qtyButton, line.qty <= 1 ? styles.qtyButtonDisabled : undefined]}
                    onPress={() => changeQty(line.id, -1)}
                    disabled={line.qty <= 1}
                  >
                    <Text style={styles.qtyButtonLabel}>-</Text>
                  </Pressable>
                  <TextInput
                    style={styles.qtyInput}
                    keyboardType="number-pad"
                    value={String(line.qty)}
                    onChangeText={(text) => updateQty(line.id, text)}
                  />
                  <Pressable style={styles.qtyButton} onPress={() => changeQty(line.id, 1)}>
                    <Text style={styles.qtyButtonLabel}>+</Text>
                  </Pressable>
                </View>

                <View style={styles.totalsLineRow}>
                  <Text style={styles.smallMeta}>Retail each {asMoney(line.retailEach)}</Text>
                  <Text style={styles.smallMeta}>Retail total {asMoney(lineRetailTotal(line))}</Text>
                </View>

                <View style={styles.totalsLineRow}>
                  <Text style={styles.smallMeta}>CMA each {asMoney(line.cmaEach)}</Text>
                  <Text style={styles.smallMeta}>CMA total {asMoney(lineCmaTotal(line))}</Text>
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={styles.bottomTotals}>
            <Text style={styles.panelTitle}>Bottom Totals</Text>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Retail Total</Text>
              <Text style={styles.totalValue}>{asMoney(retailGrandTotal)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Guest Starting Total</Text>
              <Text style={styles.totalValue}>{asMoney(guestStartingTotal)}</Text>
            </View>

            <View style={styles.editableTotalRow}>
              <Text style={styles.totalLabel}>Marketer Contribution</Text>
              <TextInput
                style={styles.moneyInput}
                editable={cartLines.length > 0}
                value={contributionInput}
                keyboardType="decimal-pad"
                onChangeText={(value) => {
                  setLastEdited("contribution");
                  setContributionInput(value);
                }}
              />
            </View>

            <View style={styles.editableTotalRow}>
              <Text style={styles.totalLabel}>Guest Final Total</Text>
              <TextInput
                style={styles.moneyInput}
                editable={cartLines.length > 0}
                value={guestFinalInput}
                keyboardType="decimal-pad"
                onChangeText={(value) => {
                  setLastEdited("guestFinal");
                  setGuestFinalInput(value);
                }}
              />
            </View>

            {guardrailText ? <Text style={styles.guardrailText}>{guardrailText}</Text> : null}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#eef5f0",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 10
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d8e5dc",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12
  },
  screenTitle: {
    fontSize: 21,
    fontWeight: "700",
    color: "#123022"
  },
  screenSubtitle: {
    marginTop: 4,
    color: "#4b6454",
    fontSize: 13
  },
  signOutButton: {
    borderRadius: 10,
    backgroundColor: "#f3ede1",
    borderWidth: 1,
    borderColor: "#dbcfb8",
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  signOutLabel: {
    color: "#4e432a",
    fontWeight: "600"
  },
  remotePanel: {
    backgroundColor: "#f7fbff",
    borderWidth: 1,
    borderColor: "#c8d7e8",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6
  },
  remotePanelTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#2a4564"
  },
  actionsInline: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center"
  },
  smallActionButton: {
    borderWidth: 1,
    borderColor: "#b7cbe1",
    backgroundColor: "#eaf3fd",
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  smallActionText: {
    color: "#2e4e71",
    fontWeight: "700",
    fontSize: 12
  },
  remoteStatusBox: {
    borderWidth: 1,
    borderColor: "#b7d7c3",
    backgroundColor: "#ecf9f0",
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 7,
    gap: 2
  },
  remoteStatusBoxError: {
    borderColor: "#dfb4b4",
    backgroundColor: "#fff2f2"
  },
  remoteStatusLabel: {
    color: "#29663f",
    fontSize: 12,
    fontWeight: "600"
  },
  remoteStatusLabelError: {
    color: "#7f3b3b"
  },
  remoteStatusStamp: {
    color: "#647e9e",
    fontSize: 11
  },
  alertInfoBar: {
    backgroundColor: "#fff6f6",
    borderWidth: 1,
    borderColor: "#e2c3c3",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6
  },
  alertInfoTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#7c3333"
  },
  alertInfoList: {
    maxHeight: 150
  },
  alertInfoRow: {
    borderWidth: 1,
    borderColor: "#e5c8c8",
    backgroundColor: "#fffdfd",
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 8,
    gap: 2
  },
  alertInfoBrand: {
    color: "#6d2d2d",
    fontWeight: "700"
  },
  alertInfoMessage: {
    color: "#7c4141",
    fontSize: 12
  },
  alertInfoStamp: {
    color: "#9a6666",
    fontSize: 11
  },
  mainWrap: {
    flex: 1,
    gap: 10
  },
  mainWrapWide: {
    flexDirection: "row"
  },
  panel: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#d8e5dc",
    padding: 12,
    gap: 8
  },
  leftPanel: {
    flex: 1
  },
  rightPanel: {
    flex: 1.15
  },
  panelTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#153626"
  },
  input: {
    borderWidth: 1,
    borderColor: "#bfd2c4",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: "#163425",
    backgroundColor: "#fbfdfb"
  },
  helperText: {
    color: "#5a7262",
    fontSize: 13
  },
  searchList: {
    maxHeight: 180
  },
  listContent: {
    gap: 8,
    paddingBottom: 4
  },
  brandRow: {
    borderWidth: 1,
    borderColor: "#cadbd0",
    borderRadius: 10,
    backgroundColor: "#f8fcf9",
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  brandRowActive: {
    borderColor: "#7ea38f",
    backgroundColor: "#e7f4eb"
  },
  brandRowText: {
    fontWeight: "600",
    color: "#1a3928"
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: "#dce7df",
    marginVertical: 2
  },
  selectedBrandLabel: {
    color: "#335845",
    fontWeight: "600"
  },
  selectedBrandAlertCard: {
    borderWidth: 1,
    borderColor: "#d8b4b4",
    borderRadius: 9,
    backgroundColor: "#fff4f4",
    paddingHorizontal: 10,
    paddingVertical: 9,
    gap: 3
  },
  selectedBrandAlertTitle: {
    color: "#7a3434",
    fontWeight: "700",
    fontSize: 13
  },
  selectedBrandAlertBody: {
    color: "#7a4242",
    fontSize: 12
  },
  selectedBrandAlertStamp: {
    color: "#9b6666",
    fontSize: 11
  },
  lineList: {
    flex: 1,
    minHeight: 120
  },
  lineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#d1dfd5",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#f9fcfa"
  },
  lineTitle: {
    color: "#163526",
    fontWeight: "600"
  },
  lineMeta: {
    color: "#566f5f",
    marginTop: 2,
    fontSize: 12
  },
  addButton: {
    borderWidth: 1,
    borderColor: "#7ea38f",
    backgroundColor: "#e6f2ea",
    borderRadius: 9,
    paddingVertical: 7,
    paddingHorizontal: 12
  },
  addButtonLabel: {
    color: "#224434",
    fontWeight: "700"
  },
  cartHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  clearButton: {
    borderWidth: 1,
    borderColor: "#ddbdbd",
    backgroundColor: "#fff0f0",
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  clearButtonLabel: {
    color: "#723838",
    fontWeight: "700"
  },
  cartList: {
    flex: 1,
    minHeight: 150
  },
  cartRow: {
    borderWidth: 1,
    borderColor: "#d0dfd4",
    borderRadius: 11,
    padding: 10,
    gap: 7,
    backgroundColor: "#fcfffc"
  },
  cartRowTop: {
    flexDirection: "row",
    alignItems: "center"
  },
  cartLineBrand: {
    fontWeight: "700",
    color: "#173627"
  },
  cartLineType: {
    marginTop: 2,
    color: "#536c5c"
  },
  removeButton: {
    borderWidth: 1,
    borderColor: "#deb4b4",
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: "#fff1f1"
  },
  removeButtonLabel: {
    color: "#7a3b3b",
    fontWeight: "600",
    fontSize: 12
  },
  qtyWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7
  },
  qtyLabel: {
    width: 32,
    color: "#355846",
    fontWeight: "600"
  },
  qtyButton: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#b8ccbf",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f1f8f3"
  },
  qtyButtonDisabled: {
    opacity: 0.45
  },
  qtyButtonLabel: {
    fontSize: 17,
    color: "#234533",
    fontWeight: "700"
  },
  qtyInput: {
    minWidth: 50,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#bfcfc5",
    textAlign: "center",
    color: "#173627"
  },
  totalsLineRow: {
    flexDirection: "row",
    justifyContent: "space-between"
  },
  smallMeta: {
    color: "#4f6a59",
    fontSize: 12
  },
  bottomTotals: {
    borderTopWidth: 1,
    borderTopColor: "#dce8df",
    paddingTop: 10,
    gap: 8
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  totalLabel: {
    color: "#234736",
    fontWeight: "600"
  },
  totalValue: {
    color: "#152f22",
    fontWeight: "700"
  },
  editableTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8
  },
  moneyInput: {
    minWidth: 110,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#bfcec4",
    backgroundColor: "#fbfdfb",
    paddingHorizontal: 8,
    paddingVertical: 7,
    color: "#143222",
    textAlign: "right"
  },
  guardrailText: {
    marginTop: 4,
    color: "#8a5d16",
    fontSize: 12
  },
  emptyHint: {
    color: "#7a8f81",
    fontStyle: "italic"
  }
});

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Role } from "../types";

interface AuthScreenProps {
  onSelectRole: (role: Role) => void;
}

export function AuthScreen({ onSelectRole }: AuthScreenProps) {
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Premium Pricing App</Text>
        <Text style={styles.subtitle}>Framework build for iPhone + iPad workflows.</Text>

        <Pressable style={[styles.roleButton, styles.marketerButton]} onPress={() => onSelectRole("marketer")}>
          <Text style={styles.roleLabel}>Enter as Marketer</Text>
          <Text style={styles.roleHint}>Search active brands, build cart, adjust contribution/final total.</Text>
        </Pressable>

        <Pressable style={[styles.roleButton, styles.adminButton]} onPress={() => onSelectRole("admin")}>
          <Text style={styles.roleLabel}>Enter as Admin</Text>
          <Text style={styles.roleHint}>Manage brands, ticket lines, active states, and extraction review.</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f3f7f2",
    padding: 24,
    justifyContent: "center"
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 22,
    gap: 14,
    borderWidth: 1,
    borderColor: "#d6e2d4",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 2
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#143222"
  },
  subtitle: {
    fontSize: 15,
    color: "#435d4b",
    marginBottom: 8
  },
  roleButton: {
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    gap: 6
  },
  marketerButton: {
    backgroundColor: "#ecf8ff",
    borderColor: "#b8ddf5"
  },
  adminButton: {
    backgroundColor: "#fff8ed",
    borderColor: "#edd7b2"
  },
  roleLabel: {
    fontSize: 17,
    fontWeight: "700",
    color: "#132f22"
  },
  roleHint: {
    color: "#496150",
    fontSize: 14,
    lineHeight: 20
  }
});

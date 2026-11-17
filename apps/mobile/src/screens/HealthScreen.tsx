import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { colors, styles } from '../theme';
import { computeHealth } from '../utils/health';
import { isArchived } from '../utils/itemMeta';

export default function HealthScreen({ items, onFix }: { items: VaultItem[]; onFix: (item: VaultItem) => void }) {
  // Archived items are excluded from health, like trashed items.
  const h = computeHealth(items.filter((i) => !isArchived(i)));
  const color = h.score >= 80 ? colors.ok : h.score >= 50 ? colors.warn : colors.danger;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.title}>Security Health</Text>
      <Text style={styles.subtitle}>Weak and reused passwords, plus cards and documents expiring in the next 30 days. Trashed and archived items are excluded.</Text>
      <View style={[styles.card, { marginTop: 16, alignItems: 'center' }]}>
        <Text testID="health-score" accessibilityLabel={`Vault health score ${h.score} out of 100`} style={{ color, fontSize: 44, fontWeight: '800' }}>{h.score}</Text>
        <Text style={{ color: colors.muted, fontSize: 13 }}>out of 100 · {h.total} item(s) checked</Text>
        <View style={{ height: 8, borderRadius: 999, backgroundColor: colors.input, marginTop: 12, width: '100%', overflow: 'hidden' }}>
          <View style={{ height: '100%', width: `${h.score}%`, backgroundColor: color, borderRadius: 999 }} />
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        <View style={[styles.card, { flex: 1, alignItems: 'center' }]}><Text style={{ color: colors.danger, fontSize: 24, fontWeight: '800' }}>{h.weakCount}</Text><Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>Weak passwords</Text></View>
        <View style={[styles.card, { flex: 1, alignItems: 'center' }]}><Text style={{ color: colors.warn, fontSize: 24, fontWeight: '800' }}>{h.reusedCount}</Text><Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>Reused passwords</Text></View>
        <View style={[styles.card, { flex: 1, alignItems: 'center' }]}><Text style={{ color: colors.text, fontSize: 24, fontWeight: '800' }}>{h.expiringItems.length}</Text><Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>Expiring soon</Text></View>
      </View>
      {h.weakItems.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>Weak passwords</Text>
          {h.weakItems.map((i) => (
            <Pressable key={i.id} testID={`health-fix-${i.id}`} accessibilityLabel={`Fix weak password for ${i.title}`} onPress={() => onFix(i)} style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{i.title}</Text>
              <Text style={{ color: colors.danger, fontSize: 13, marginTop: 2 }}>Tap to fix →</Text>
            </Pressable>
          ))}
        </View>
      )}
      {h.reusedGroups.length > 0 && (
        <View style={{ marginTop: 12 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>Reused passwords</Text>
          {h.reusedGroups.map((g, idx) => (
            <View key={idx} style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 }}>
              <Text style={{ color: colors.text, fontSize: 15 }}>Used by {g.itemIds.length} items</Text>
              <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>Change it to a unique password on each account, starting with the most important.</Text>
            </View>
          ))}
        </View>
      )}
      {h.expiringItems.length > 0 && (
        <View style={{ marginTop: 12 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 }}>Expiring in the next 30 days</Text>
          {h.expiringItems.map((i) => (
            <Pressable key={i.id} testID={`health-expiring-${i.id}`} accessibilityLabel={`Open expiring item ${i.title}`} onPress={() => onFix(i)} style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{i.title}</Text>
              <Text style={{ color: colors.warn, fontSize: 13, marginTop: 2 }}>Expires {(i.fields as Record<string, unknown>).expiry_date as string ?? (i.fields as Record<string, unknown>).expiry as string}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {h.weakItems.length === 0 && h.reusedGroups.length === 0 && h.expiringItems.length === 0 ? (
        <View style={{ alignItems: 'center', marginTop: 32 }}><Text style={{ fontSize: 40 }}>✅</Text><Text style={{ color: colors.muted, fontSize: 14, marginTop: 8, textAlign: 'center' }}>All clear — no weak or reused passwords, nothing expiring soon.</Text></View>
      ) : null}
    </ScrollView>
  );
}

import { StyleSheet } from 'react-native';

// Dark premium mobile theme, same palette as the desktop app (#0B0F14).
export const colors = {
  bg: '#0B0F14',
  card: '#151B23',
  cardBorder: '#262E3A',
  input: '#1B222C',
  text: '#F4F4F5',
  muted: '#9CA3AF',
  faint: '#6B7280',
  accent: '#6366F1',
  accentSoft: 'rgba(99,102,241,0.22)',
  danger: '#EF4444',
  dangerSoft: 'rgba(239,68,68,0.15)',
  warn: '#F59E0B',
  warnSoft: 'rgba(245,158,11,0.15)',
  ok: '#10B981',
  okSoft: 'rgba(16,185,129,0.15)',
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: 16 },
  card: { backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 16, padding: 16 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 4 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: { backgroundColor: colors.input, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, color: colors.text, fontSize: 16, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12 },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  primaryButton: { backgroundColor: colors.accent, borderRadius: 12, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  ghostButton: { borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  ghostButtonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  dangerButton: { backgroundColor: colors.danger, borderRadius: 12, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  chip: { backgroundColor: colors.accentSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { color: '#C7D2FE', fontSize: 12, fontWeight: '600' },
});

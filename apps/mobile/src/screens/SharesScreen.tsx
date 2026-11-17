import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Field from '../components/Field';
import { colors, styles } from '../theme';

/**
 * Sharing (mobile) — proposals only, NOT production-ready.
 *
 * The HPKE / sealed-box key-exchange step is not implemented, so this
 * screen can only record a PENDING proposal on this device. No key is
 * ever exchanged here, no share is ever active, and no proposal is ever
 * sent to a server. Proposals are stored in AsyncStorage (local only)
 * under MY-SECRECT-SHARES-KEY and are downgraded to 'pending' on load
 * if a stored record ever claims to be active — this build cannot have
 * an active share, so displaying one would be a lie.
 *
 * Revocation removes the proposal. It does NOT erase copies a recipient
 * already decrypted — re-sharing after revocation requires key rotation.
 */

const LS_SHARES = 'my-secrect.shares.pending.v1';

export interface ShareProposal {
  id: string;
  recipient_id: string;
  permission: 'read' | 'write';
  status: 'pending' | 'revoked';
  created_at: string;
  revoked_at: string | null;
}

function newShareId(): string {
  const bytes = new Uint8Array(12);
  // Math.random here only builds an opaque local id, never a key.
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'share_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadProposals(): Promise<ShareProposal[]> {
  try {
    const raw = await AsyncStorage.getItem(LS_SHARES);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is ShareProposal => typeof s === 'object' && s !== null && typeof (s as ShareProposal).id === 'string' && typeof (s as ShareProposal).recipient_id === 'string')
      .map((s) => ({ ...s, status: s.status === 'revoked' ? 'revoked' as const : 'pending' as const, revoked_at: s.status === 'revoked' ? (s.revoked_at ?? null) : null }));
  } catch {
    return [];
  }
}

export default function SharesScreen({ onClose }: { onClose: () => void }) {
  const [shares, setShares] = useState<ShareProposal[]>([]);
  const [recipientId, setRecipientId] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('read');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void loadProposals().then((list) => { setShares(list); setLoaded(true); });
  }, []);

  async function persist(next: ShareProposal[]) {
    setShares(next);
    try { await AsyncStorage.setItem(LS_SHARES, JSON.stringify(next)); } catch { /* proposals are non-critical */ }
  }

  function handleCreate() {
    setError('');
    if (!recipientId.trim()) { setError('Recipient user id is required.'); return; }
    const proposal: ShareProposal = {
      id: newShareId(),
      recipient_id: recipientId.trim(),
      permission,
      status: 'pending',
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    void persist([...shares, proposal]);
    setRecipientId('');
  }

  function handleRevoke(share: ShareProposal) {
    Alert.alert('Revoke share proposal?', 'This removes the proposal from this device. It does not erase copies a recipient already decrypted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke', style: 'destructive',
        onPress: () => { void persist(shares.map((s) => (s.id === share.id ? { ...s, status: 'revoked' as const, revoked_at: new Date().toISOString() } : s))); },
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Pressable testID="shares-back" accessibilityLabel="Back to vault" onPress={onClose} hitSlop={10} style={{ alignSelf: 'flex-start', paddingVertical: 8 }}><Text style={{ color: '#A5B4FC', fontSize: 15 }}>‹ Back</Text></Pressable>
      <Text style={styles.title}>Sharing</Text>
      <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 }}>
        Share a vault with another person via a wrapped key envelope — the server would see only the envelope and opaque ids, never plaintext or the Vault Key.
      </Text>
      <View style={{ backgroundColor: '#3A2A00', borderColor: '#7A5A00', borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 }}>
        <Text style={{ color: '#FCD34D', fontSize: 13, lineHeight: 18, fontWeight: '600' }}>
          Not production-ready — key exchange not implemented. Proposals saved here are PENDING only: no key is exchanged and no share is active.
        </Text>
      </View>
      <Text style={[styles.label, { marginTop: 20 }]}>Share this vault</Text>
      <Field label="Recipient user id" testID="share-recipient" placeholder="Opaque recipient id" value={recipientId} onChangeText={setRecipientId} autoCapitalize="none" autoCorrect={false} />
      <Text style={styles.label}>Permission</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {(['read', 'write'] as const).map((p) => (
          <Pressable key={p} testID={`share-permission-${p}`} accessibilityLabel={`Permission ${p}`} onPress={() => setPermission(p)} style={{ backgroundColor: permission === p ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, marginRight: 8, marginBottom: 8 }}>
            <Text style={{ color: permission === p ? '#FFF' : colors.text, fontWeight: '600' }}>{p === 'read' ? 'Read — view and copy' : 'Write — view, copy and edit'}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text testID="share-error" style={[styles.error, { marginBottom: 10 }]}>{error}</Text> : null}
      <Pressable testID="create-share-button" accessibilityLabel="Create share proposal" style={styles.primaryButton} onPress={handleCreate}>
        <Text style={styles.primaryButtonText}>Create share proposal</Text>
      </Pressable>
      <Text style={[styles.label, { marginTop: 20 }]}>Proposals</Text>
      {!loaded ? (
        <Text style={{ color: colors.muted }}>Loading…</Text>
      ) : shares.length === 0 ? (
        <Text style={{ color: colors.muted }}>No share proposals yet.</Text>
      ) : (
        shares.map((s) => (
          <View key={s.id} style={{ backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>Recipient: {s.recipient_id}</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{s.permission} · {s.status}{s.revoked_at ? ` · revoked ${new Date(s.revoked_at).toLocaleString()}` : ''}</Text>
            {s.status === 'pending' ? (
              <Pressable testID={`revoke-share-${s.id}`} accessibilityLabel="Revoke share proposal" style={[styles.ghostButton, { marginTop: 10 }]} onPress={() => handleRevoke(s)}>
                <Text style={styles.ghostButtonText}>Revoke</Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}
      <Text style={{ color: colors.faint, fontSize: 12, lineHeight: 17, marginTop: 12 }}>
        Revoking removes the proposal. It does not erase copies a recipient already decrypted — re-sharing after revocation requires key rotation.
      </Text>
    </ScrollView>
  );
}

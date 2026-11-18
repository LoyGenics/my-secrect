import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Field from '../components/Field';
import { Empty, Select } from '../components/mobile-ui';
import { illustrations } from '../../../../packages/ui/src/native';
import { useMobileTheme } from '../theme';
import { decryptWithVaultKey, encryptWithVaultKey, listItems, upsertItem } from '../vault';
import { getApiToken } from './SecurityScreen';
// From apps/mobile/src/screens/ the repo root is four levels up.
import type { VaultItem } from '../../../../packages/core/src/types';
import { fingerprintOf, type SharePermission } from '../../../../packages/core/src/sharing';
import {
  SharingApiClient,
  SharingSession,
  classifyShareError,
  shareActions,
  sharePeer,
  type ContactView,
  type OpenedShare,
  type PeerView,
  type ShareErrorKind,
  type SharingSessionOptions,
  type ShareSummary,
} from '../../../../packages/sdk/src/sharing';
import { SecurityApiClient } from '../../../../packages/sdk/src/security';
import { useTranslation } from '../../../../packages/i18n/src/react';

/**
 * Sharing (mobile) — end-to-end encrypted item sharing, same protocol and
 * SharingSession as desktop/web (specs/sharing-protocol.md).
 *
 *  - "Your sharing key" is derived from the locally decrypted identity.
 *  - Sharing and accepting require the other person's key to be verified
 *    (fingerprint compared in person or on a call, then pinned on this
 *    device in AsyncStorage, encrypted under the Vault Key, with the email
 *    it was verified under). Verified contacts are shown by their PINNED
 *    email; unverified emails are labelled as what the server says. A
 *    changed key or relabelled email blocks; only forget + re-verify
 *    continues.
 *  - Accept runs the key-exchange check first; the server keeps the content
 *    back until the share is accepted.
 *  - Recipient edits reach the owner's vault only via "Save this version to
 *    my vault", which saves exactly the revision on screen.
 *  - Creating or resetting the sharing key needs a server step-up. Mobile
 *    has no passkeys, so that is an authenticator (TOTP) code; accounts
 *    without TOTP create their key on desktop/web.
 *  - Revoke states that seen data cannot be erased remotely.
 * No server configured or no session: the screen says so and does nothing.
 */

type Expiry = '1' | '7' | '30' | 'never';
const EXPIRIES: Expiry[] = ['1', '7', '30', 'never'];

function expiresAtFor(expiry: Expiry): string | null {
  return expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
}

const ERROR_KEYS: Partial<Record<ShareErrorKind, string>> = {
  not_verified: 'shares.errorNotVerified',
  key_changed: 'shares.errorKeyChanged',
  relabeled: 'shares.errorRelabeled',
  crypto: 'shares.errorCrypto',
  revoked: 'shares.errorRevoked',
  expired: 'shares.errorExpired',
  not_active: 'shares.errorNotActive',
  read_only: 'shares.errorReadOnly',
  conflict: 'shares.errorConflict',
  unauthorized: 'shares.signedOut',
};

const pinStorage = {
  getItem: (k: string) => AsyncStorage.getItem(k),
  setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
  removeItem: (k: string) => AsyncStorage.removeItem(k),
};

const box = (bg: string, border: string) => ({ backgroundColor: bg, borderColor: border, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 10 });
const mono = { fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }), letterSpacing: 1 } as const;

function Button({ label, onPress, primary, disabled, testID }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean; testID: string }) {
  const { colors, styles } = useMobileTheme();
  return (
    <Pressable testID={testID} accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={[primary ? styles.primaryButton : styles.ghostButton, { marginTop: 8, opacity: disabled ? 0.5 : 1 }]}>
      <Text style={primary ? styles.primaryButtonText : styles.ghostButtonText}>{label}</Text>
    </Pressable>
  );
}

function Chip({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID: string }) {
  const { colors, styles } = useMobileTheme();
  return (
    <Pressable testID={testID} accessibilityLabel={label} onPress={onPress}
      style={{ backgroundColor: selected ? colors.accent : colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, marginRight: 8, marginBottom: 8 }}>
      <Text style={{ color: selected ? '#FFF' : colors.text, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export default function SharesScreen({ baseUrl, onClose }: { baseUrl: string; onClose: () => void }) {
  const [section, setSection] = useState('inbox');
  const { colors, styles } = useMobileTheme();
  const cardStyle = { backgroundColor: colors.card, borderRadius: 14, padding: 16, marginBottom: 10 };
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'starting' | 'no-server' | 'signed-out' | 'failed' | 'ready'>('starting');
  const [startError, setStartError] = useState<{ kind: ShareErrorKind; detail: string } | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  // Pending action that needs a fresh server step-up (TOTP on mobile).
  const [stepUpFor, setStepUpFor] = useState<null | (() => void)>(null);
  const [stepUpCode, setStepUpCode] = useState('');
  const [session, setSession] = useState<SharingSession | null>(null);
  const sessionRef = useRef<SharingSession | null>(null);
  const [myFingerprint, setMyFingerprint] = useState('');
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [peerFingerprints, setPeerFingerprints] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const items = listItems();
  const [itemId, setItemId] = useState('');
  const [email, setEmail] = useState('');
  const [contact, setContact] = useState<ContactView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [permission, setPermission] = useState<SharePermission>('read');
  const [expiry, setExpiry] = useState<Expiry>('7');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ share: ShareSummary; data: OpenedShare } | null>(null);
  const [draft, setDraft] = useState<{ title: string; fields: Record<string, string> } | null>(null);
  const [revealed, setRevealed] = useState(false);

  const report = useCallback((e: unknown) => {
    const c = classifyShareError(e);
    const key = ERROR_KEYS[c.kind];
    setNotice('');
    if (key) setError(t(key));
    else if (c.kind === 'identity') setError(t('shares.unavailable', c.detail));
    else if (c.kind === 'invalid_content') setError(t('shares.errorInvalidContent', c.detail));
    else setError(t('shares.errorGeneric', c.detail));
  }, [t]);

  const sessionOptions = (url: string): SharingSessionOptions => ({
    api: new SharingApiClient({ baseUrl: url, getToken: getApiToken }),
    vault: { encrypt: encryptWithVaultKey, decrypt: decryptWithVaultKey },
    pinStorage,
    items: { find: (id) => listItems().find((i) => i.id === id), save: upsertItem },
  });

  const refresh = useCallback(async (s: SharingSession) => {
    const list = await s.listShares();
    const fps: Record<string, string> = {};
    for (const share of list) fps[share.id] = await fingerprintOf(sharePeer(share).publicKey);
    setShares(list);
    setPeerFingerprints(fps);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!baseUrl) return setPhase('no-server');
      if (!(await getApiToken())) return setPhase('signed-out');
      setPhase('starting');
      setStartError(null);
      try {
        const s = await SharingSession.start(sessionOptions(baseUrl));
        if (cancelled) return s.close();
        sessionRef.current = s;
        setMyFingerprint(await s.myFingerprint());
        setSession(s);
        setPhase('ready');
        await refresh(s);
      } catch (e) {
        if (cancelled) return;
        const c = classifyShareError(e);
        setStartError(c);
        setPhase(c.kind === 'unauthorized' ? 'signed-out' : 'failed');
      }
    })();
    return () => {
      cancelled = true;
      sessionRef.current?.close();
      sessionRef.current = null;
    };
    // sessionOptions only reads module-level functions and its argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, refresh, startAttempt]);

  /** Server step-up with an authenticator code, then the pending action. */
  const submitStepUp = () => {
    const next = stepUpFor;
    if (!next || !baseUrl) return;
    setBusy(true);
    setError('');
    new SecurityApiClient({ baseUrl, getToken: getApiToken }).stepUpTotp(stepUpCode.trim())
      .then(() => {
        setStepUpFor(null);
        setStepUpCode('');
        next();
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  /** Reset the identity (needs step-up). Replaces the running session. */
  const resetIdentity = () => {
    if (!baseUrl) return;
    setBusy(true);
    setError('');
    setNotice('');
    SharingSession.resetIdentity(sessionOptions(baseUrl))
      .then(async (s) => {
        sessionRef.current?.close();
        sessionRef.current = s;
        setMyFingerprint(await s.myFingerprint());
        setSession(s);
        setStartError(null);
        setPhase('ready');
        setNotice(t('shares.resetDone'));
        await refresh(s);
      })
      .catch((e) => {
        if (classifyShareError(e).kind === 'step_up') setStepUpFor(() => resetIdentity);
        else report(e);
      })
      .finally(() => setBusy(false));
  };
  const confirmResetIdentity = () => {
    Alert.alert(t('shares.resetKey'), t('shares.resetKeyWarning'), [
      { text: t('shares.cancel'), style: 'cancel' },
      { text: t('shares.confirmReset'), style: 'destructive', onPress: resetIdentity },
    ]);
  };

  const run = (fn: (s: SharingSession) => Promise<void>) => {
    if (!session || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    fn(session).catch(report).finally(() => setBusy(false));
  };

  const lookUp = () => run(async (s) => {
    setContact(null);
    setNotFound(false);
    const found = await s.lookupContact(email);
    if (found) setContact(found);
    else setNotFound(true);
  });
  const verifyContact = (c: ContactView) => run(async (s) => {
    await s.verifyContact(c);
    setContact(await s.lookupContact(c.email));
  });
  const forgetContact = (userId: string) => run(async (s) => {
    await s.forgetContact(userId);
    if (contact) setContact(await s.lookupContact(contact.email));
    await refresh(s);
  });
  const doShare = () => run(async (s) => {
    const item = items.find((i) => i.id === itemId);
    if (!item || !contact) return;
    await s.shareItem({ item, contact, permission, expiresAt: expiresAtFor(expiry) });
    setNotice(t('shares.shared', contact.email));
    setContact(null);
    setEmail('');
    await refresh(s);
  });
  const verifyOwner = (share: ShareSummary) => run(async (s) => {
    await s.verifyContact({ user_id: share.owner.id, email: share.owner.email, public_key: share.owner_public_key });
    setVerifyingId(null);
    await refresh(s);
  });
  const accept = (share: ShareSummary) => run(async (s) => {
    await s.acceptShare(share);
    setNotice(t('shares.accepted', s.peerView(share).email));
    await refresh(s);
  });
  const open = (share: ShareSummary) => run(async (s) => {
    setOpened({ share, data: await s.openShare(share) });
    setDraft(null);
    setRevealed(false);
  });
  const sendLatest = (share: ShareSummary) => run(async (s) => {
    const revision = await s.sendLatestVersion(share);
    setNotice(t('shares.sentLatest', revision));
    if (opened?.share.id === share.id) setOpened({ share, data: await s.openShare(share) });
    await refresh(s);
  });
  // Saves exactly the revision on screen (opened.data), never a newer one.
  const saveToVault = () => run(async (s) => {
    if (!opened) return;
    await s.saveToVault(opened.share, opened.data);
    setNotice(t('shares.savedToVault'));
  });
  const saveDraft = () => run(async (s) => {
    if (!opened || !draft) return;
    const { share, data } = opened;
    const item: VaultItem = { ...data.item, title: draft.title, fields: { ...data.item.fields, ...draft.fields }, updated_at: new Date().toISOString() };
    const revision = await s.writeShare(share, item, data.revision);
    setNotice(t('shares.savedRevision', revision));
    setDraft(null);
    setOpened({ share, data: await s.openShare(share) });
    await refresh(s);
  });
  const confirmRevoke = (share: ShareSummary, label: string) => {
    Alert.alert(label, share.role === 'owner' ? t('shares.revokeLimit') : undefined, [
      { text: t('shares.cancel'), style: 'cancel' },
      {
        text: label, style: 'destructive',
        onPress: () => run(async (s) => {
          await s.revokeShare(share);
          if (opened?.share.id === share.id) setOpened(null);
          setNotice(t('shares.revoked'));
          await refresh(s);
        }),
      },
    ]);
  };

  const statusLabel = (share: ShareSummary) => {
    if (share.status === 'revoked') return t('shares.statusRevoked');
    if (share.expired) return t('shares.statusExpired');
    return share.status === 'active' ? t('shares.statusActive') : t('shares.statusPending');
  };
  const meta = (share: ShareSummary) => [
    share.permission === 'write' ? t('shares.permWrite') : t('shares.permRead'),
    statusLabel(share),
    share.expires_at ? t('shares.expiresOn', new Date(share.expires_at).toLocaleString()) : t('shares.noExpiry'),
  ].join(' · ');
  /** Verified peers by their PINNED email; anyone else as "the server says". */
  const peerLabel = (peer: PeerView) => (peer.state === 'verified' ? peer.email : t('shares.serverSays', peer.serverEmail));
  const blocked = (peer: PeerView) => peer.state === 'changed' || peer.state === 'relabeled';

  const peerWarning = (share: ShareSummary, peer: PeerView) => (
    <View style={box(colors.dangerSoft, colors.danger)}>
      <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>
        {peer.state === 'relabeled'
          ? t('shares.relabeled', peer.serverEmail, peer.pinnedEmail ?? '—')
          : t('shares.keyChanged', peer.pinnedFingerprint ?? '—', peer.pinnedEmail ?? peer.serverEmail)}
      </Text>
      <Text style={[{ color: colors.text, marginTop: 6 }, mono]}>{peerFingerprints[share.id]}</Text>
      <Button testID={`forget-${share.id}`} label={t('shares.forgetAndReverify')} disabled={busy} onPress={() => forgetContact(peer.userId)} />
    </View>
  );

  const stepUpPanel = stepUpFor ? (
    <View style={box(colors.warnSoft, colors.warn)}>
      <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18, marginBottom: 8 }}>{t('shares.stepUpNeeded')}</Text>
      <Field label={t('shares.stepUpCode')} testID="share-stepup-code" value={stepUpCode} onChangeText={setStepUpCode} keyboardType="number-pad" autoComplete="one-time-code" />
      <Button testID="share-stepup-verify" primary label={t('shares.stepUpVerify')} disabled={busy || stepUpCode.trim().length < 6} onPress={submitStepUp} />
      <Button testID="share-stepup-cancel" label={t('shares.cancel')} onPress={() => { setStepUpFor(null); setStepUpCode(''); }} />
    </View>
  ) : null;

  const header = null;

  if (phase !== 'ready' || !session) {
    const needsStepUp = phase === 'failed' && startError?.kind === 'step_up';
    let message = t('shares.starting');
    if (phase === 'no-server') message = t('shares.notConfigured');
    else if (phase === 'signed-out') message = t('shares.signedOut');
    else if (needsStepUp) message = t('shares.stepUpNeeded');
    else if (phase === 'failed') message = t('shares.unavailable', startError?.detail ?? '');
    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, width: '100%', maxWidth: 720, alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        {header}
        {phase === 'no-server' || phase === 'signed-out' ? <Empty image={illustrations.emptyVault} title={t('mobileUI.sharingConnect')} detail={phase === 'signed-out' ? message : t('mobileUI.sharingConnectBody')} /> : <Text testID="shares-status" style={[phase === 'failed' && !needsStepUp ? styles.error : styles.subtitle, { marginTop: 12 }]}>{message}</Text>}
        {error ? <Text testID="shares-error" style={[styles.error, { marginTop: 10 }]}>{error}</Text> : null}
        {needsStepUp && !stepUpFor ? (
          <Button testID="share-stepup-start" primary label={t('shares.verifyItsYou')} onPress={() => setStepUpFor(() => () => setStartAttempt((n) => n + 1))} />
        ) : null}
        {phase === 'failed' && startError?.kind === 'identity' && !stepUpFor ? (
          <Button testID="share-reset-key" label={t('shares.resetKey')} disabled={busy} onPress={confirmResetIdentity} />
        ) : null}
        {stepUpPanel}
      </ScrollView>
    );
  }

  const incoming = shares.filter((s) => s.role === 'recipient');
  const outgoing = shares.filter((s) => s.role === 'owner');

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingBottom: 40, width: '100%', maxWidth: 720, alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
      {header}
      {notice ? <Text testID="shares-notice" style={{ color: colors.ok, marginTop: 10 }}>{notice}</Text> : null}
      {error ? <Text testID="shares-error" style={[styles.error, { marginTop: 10 }]}>{error}</Text> : null}

      {stepUpPanel}
      <Select label={t('shares.title')} testID="shares-section" value={section} choices={[
        { value: 'inbox', label: t('shares.sharedWithMe') }, { value: 'sent', label: t('shares.sharedByMe') },
        { value: 'new', label: t('shares.shareItem') }, { value: 'identity', label: t('shares.myKey') },
      ]} onChange={value => { setSection(value); setOpened(null); setDraft(null); }} />
      {!opened && section === 'identity' && <>
      <View style={[styles.card, { marginTop: 16 }]}>
        <Text style={styles.label}>{t('shares.myKey')}</Text>
        <Text testID="my-fingerprint" style={[{ color: colors.text, fontSize: 18 }, mono]}>{myFingerprint}</Text>
        <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 6 }}>{t('shares.myKeyHelp')}</Text>
        {stepUpFor ? null : <Button testID="share-reset-key" label={t('shares.resetKey')} disabled={busy} onPress={confirmResetIdentity} />}
      </View>
      </>}

      {!opened && section === 'new' && <>
      <Text style={[styles.label, { marginTop: 20 }]}>{t('shares.shareItem')}</Text>
      <Select testID="share-item" label={t('shares.item')} value={itemId} choices={items.map(item => ({ value: item.id, label: item.title }))} onChange={setItemId} />
      <Field label={t('shares.recipientEmail')} testID="share-recipient" value={email} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
        onChangeText={(v) => { setEmail(v); setContact(null); setNotFound(false); }} />
      <Button testID="share-lookup" label={t('shares.lookUp')} disabled={busy || !email.trim()} onPress={lookUp} />
      {notFound ? <Text style={{ color: colors.muted, marginTop: 8 }}>{t('shares.noSuchRecipient')}</Text> : null}
      {contact ? (
        <View style={box(colors.card, colors.cardBorder)}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>{t('shares.serverFingerprint', contact.email)}</Text>
          <Text testID="recipient-fingerprint" style={[{ color: colors.text, fontSize: 16, marginTop: 4 }, mono]}>{contact.fingerprint}</Text>
          {contact.pinState === 'verified' ? <Text style={{ color: colors.ok, marginTop: 8 }}>{t('shares.verified')}</Text> : null}
          {contact.pinState === 'unverified' ? (
            <View style={box(colors.warnSoft, colors.warn)}>
              <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>{t('shares.verifyInstructions', contact.email)}</Text>
              <Button testID="share-verify" primary label={t('shares.digitsMatch')} disabled={busy} onPress={() => verifyContact(contact)} />
            </View>
          ) : null}
          {contact.pinState === 'changed' || contact.pinState === 'relabeled' ? (
            <View style={box(colors.dangerSoft, colors.danger)}>
              <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>
                {contact.pinState === 'relabeled'
                  ? t('shares.relabeled', contact.email, contact.pinnedEmail ?? '—')
                  : t('shares.keyChanged', contact.pinnedFingerprint ?? '—', contact.email)}
              </Text>
              <Button testID="share-forget" label={t('shares.forgetAndReverify')} disabled={busy} onPress={() => forgetContact(contact.user_id)} />
            </View>
          ) : null}
        </View>
      ) : null}
      <Select testID="share-permission" label={t('shares.permission')} value={permission} choices={[{ value: 'read', label: t('shares.permRead') }, { value: 'write', label: t('shares.permWrite') }]} onChange={value => setPermission(value as 'read' | 'write')} />
      <Select testID="share-expiry" label={t('shares.expiry')} value={expiry} choices={EXPIRIES.map(value => ({ value, label: value === 'never' ? t('shares.expiryNever') : t(`shares.expiry${value}`) }))} onChange={value => setExpiry(value as typeof expiry)} />
      <Button testID="create-share-button" primary label={t('shares.share')} disabled={busy || !itemId || contact?.pinState !== 'verified'} onPress={doShare} />

      </>}
      {!opened && section === 'inbox' && <>
      <Text style={[styles.label, { marginTop: 24 }]}>{t('shares.sharedWithMe')}</Text>
      {incoming.length === 0 ? <Text style={{ color: colors.muted }}>{t('shares.none')}</Text> : incoming.map((share) => {
        const actions = shareActions(share);
        const peer = session.peerView(share);
        return (
          <View key={share.id} style={cardStyle}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{t('shares.from', peerLabel(peer))}</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{meta(share)}</Text>
            {actions.canRevoke && blocked(peer) ? peerWarning(share, peer) : null}
            {actions.canAccept && peer.state === 'unverified' ? (
              verifyingId === share.id ? (
                <View style={box(colors.warnSoft, colors.warn)}>
                  <Text style={{ color: colors.muted, fontSize: 12 }}>{t('shares.serverFingerprint', peer.serverEmail)}</Text>
                  <Text style={[{ color: colors.text, marginTop: 4 }, mono]}>{peerFingerprints[share.id]}</Text>
                  <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18, marginTop: 6 }}>{t('shares.verifyInstructions', peer.serverEmail)}</Text>
                  <Button testID={`verify-owner-confirm-${share.id}`} primary label={t('shares.digitsMatch')} disabled={busy} onPress={() => verifyOwner(share)} />
                  <Button testID={`verify-owner-cancel-${share.id}`} label={t('shares.cancel')} onPress={() => setVerifyingId(null)} />
                </View>
              ) : <Button testID={`verify-owner-${share.id}`} label={t('shares.verifyOwner', peer.serverEmail)} onPress={() => setVerifyingId(share.id)} />
            ) : null}
            {actions.canAccept && peer.state === 'verified' ? <Button testID={`accept-${share.id}`} primary label={t('shares.accept')} disabled={busy} onPress={() => accept(share)} /> : null}
            {actions.canOpen && peer.state === 'verified' ? <Button testID={`open-${share.id}`} label={t('shares.open')} disabled={busy} onPress={() => open(share)} /> : null}
            {actions.canRevoke ? (
              <Button testID={`leave-${share.id}`} label={share.status === 'pending' ? t('shares.decline') : t('shares.leave')} disabled={busy}
                onPress={() => confirmRevoke(share, share.status === 'pending' ? t('shares.decline') : t('shares.leave'))} />
            ) : null}
          </View>
        );
      })}

      </>}
      {!opened && section === 'sent' && <>
      <Text style={[styles.label, { marginTop: 24 }]}>{t('shares.sharedByMe')}</Text>
      {outgoing.length === 0 ? <Text style={{ color: colors.muted }}>{t('shares.none')}</Text> : outgoing.map((share) => {
        const actions = shareActions(share);
        const peer = session.peerView(share);
        return (
          <View key={share.id} style={cardStyle}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{t('shares.to', peerLabel(peer))}</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{meta(share)}</Text>
            {actions.canRevoke && blocked(peer) ? peerWarning(share, peer) : null}
            {actions.canOpen && peer.state === 'verified' ? <Button testID={`open-${share.id}`} label={t('shares.open')} disabled={busy} onPress={() => open(share)} /> : null}
            {actions.canEdit && peer.state === 'verified' ? <Button testID={`send-latest-${share.id}`} label={t('shares.sendLatest')} disabled={busy} onPress={() => sendLatest(share)} /> : null}
            {actions.canRevoke ? <Button testID={`revoke-share-${share.id}`} label={t('shares.revoke')} disabled={busy} onPress={() => confirmRevoke(share, t('shares.confirmRevoke'))} /> : null}
          </View>
        );
      })}
      <Text style={{ color: colors.faint, fontSize: 12, lineHeight: 17, marginTop: 8 }}>{t('shares.revokeLimit')}</Text>

      </>}

      {opened ? (
        <View style={[styles.card, { marginTop: 20 }]}>
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700' }}>{opened.data.item.title}</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>
            {t('shares.revision', opened.data.revision)} · {opened.data.lastWriter === 'recipient' ? t('shares.lastWriterRecipient') : t('shares.lastWriterOwner')}
          </Text>
          {draft ? (
            <View style={{ marginTop: 12 }}>
              <Field label={t('shares.item')} testID="share-edit-title" value={draft.title} onChangeText={(v) => setDraft({ ...draft, title: v })} />
              {Object.entries(draft.fields).map(([name, value]) => (
                <Field key={name} label={name} testID={`share-edit-${name}`} value={value} autoCapitalize="none" autoCorrect={false}
                  onChangeText={(v) => setDraft({ ...draft, fields: { ...draft.fields, [name]: v } })} />
              ))}
              <Button testID="share-edit-save" primary label={t('shares.saveChanges')} disabled={busy} onPress={saveDraft} />
              <Button testID="share-edit-cancel" label={t('shares.cancel')} onPress={() => setDraft(null)} />
            </View>
          ) : (
            <View style={{ marginTop: 12 }}>
              {Object.entries(opened.data.item.fields).map(([name, value]) => (
                <View key={name} style={{ marginBottom: 8 }}>
                  <Text style={styles.label}>{name}</Text>
                  <Text style={[{ color: colors.text }, mono]} selectable={revealed}>{revealed ? (typeof value === 'string' ? value : JSON.stringify(value)) : '••••••••'}</Text>
                </View>
              ))}
              <Button testID="share-reveal" label={revealed ? t('shares.hide') : t('shares.reveal')} onPress={() => setRevealed((v) => !v)} />
              {shareActions(opened.share).canEdit ? (
                <Button testID="share-edit" label={t('shares.edit')} onPress={() => setDraft({
                  title: opened.data.item.title,
                  fields: Object.fromEntries(Object.entries(opened.data.item.fields).filter((e): e is [string, string] => typeof e[1] === 'string')),
                })} />
              ) : null}
              {opened.share.role === 'owner' && opened.data.lastWriter === 'recipient' ? (
                <Button testID="share-save-to-vault" primary label={t('shares.saveToVault')} disabled={busy} onPress={saveToVault} />
              ) : null}
            </View>
          )}
          <Button testID="share-close" label={t('shares.close')} onPress={() => { setOpened(null); setDraft(null); }} />
        </View>
      ) : null}
    </ScrollView>
  );
}

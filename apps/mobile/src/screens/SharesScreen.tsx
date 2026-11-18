import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppTextField } from '../components/Field';
import { AppButton, AppPage, BottomSheet, EmptyState, FieldGroup, FormSection, Group, InlineError, PageSection, Progress, Rule, SegmentedControl, SelectField, SettingsRow } from '../components/mobile-ui';
import { textStyle } from '../ui/tokens';
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

const mono = { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) } as const;
type ShareSection = 'overview' | 'inbox' | 'sent' | 'new' | 'identity';

export default function SharesScreen({ baseUrl }: { baseUrl: string; onClose?: () => void }) {
  const [section, setSection] = useState<ShareSection>('overview');
  const { colors } = useMobileTheme();
  const { t, dict, locale } = useTranslation();
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
    share.expires_at ? t('shares.expiresOn', new Date(share.expires_at).toLocaleString(locale)) : t('shares.noExpiry'),
  ].join(' · ');
  /** Verified peers by their PINNED email; anyone else as "the server says". */
  const peerLabel = (peer: PeerView) => (peer.state === 'verified' ? peer.email : t('shares.serverSays', peer.serverEmail));
  const blocked = (peer: PeerView) => peer.state === 'changed' || peer.state === 'relabeled';

  const peerWarning = (share: ShareSummary, peer: PeerView) => (
    <FormSection>
      <InlineError>
        {peer.state === 'relabeled'
          ? t('shares.relabeled', peer.serverEmail, peer.pinnedEmail ?? '—')
          : t('shares.keyChanged', peer.pinnedFingerprint ?? '—', peer.pinnedEmail ?? peer.serverEmail)}
      </InlineError>
      <Text style={[textStyle.body, mono, { color: colors.text }]}>{peerFingerprints[share.id]}</Text>
      <AppButton testID={`forget-${share.id}`} variant="secondary" label={t('shares.forgetAndReverify')} disabled={busy} onPress={() => forgetContact(peer.userId)} />
    </FormSection>
  );

  const closeStepUp = () => { setStepUpFor(null); setStepUpCode(''); };
  const stepUpPanel = (
    <BottomSheet visible={Boolean(stepUpFor)} onClose={closeStepUp} title={t('shares.verifyItsYou')} testID="shares-stepup">
      <FormSection description={t('shares.stepUpNeeded')}>
        <AppTextField label={t('shares.stepUpCode')} testID="share-stepup-code" value={stepUpCode} onChangeText={setStepUpCode} keyboardType="number-pad" autoComplete="one-time-code" />
        {error && <InlineError>{error}</InlineError>}
        <AppButton testID="share-stepup-verify" label={t('shares.stepUpVerify')} loading={busy} disabled={stepUpCode.trim().length < 6} onPress={submitStepUp} />
        <AppButton testID="share-stepup-cancel" variant="secondary" label={t('shares.cancel')} disabled={busy} onPress={closeStepUp} />
      </FormSection>
    </BottomSheet>
  );

  if (phase !== 'ready' || !session) {
    const needsStepUp = phase === 'failed' && startError?.kind === 'step_up';
    let message = t('shares.starting');
    if (phase === 'no-server') message = t('shares.notConfigured');
    else if (phase === 'signed-out') message = t('shares.signedOut');
    else if (needsStepUp) message = t('shares.stepUpNeeded');
    else if (phase === 'failed') message = t('shares.unavailable', startError?.detail ?? '');
    return (
      <AppPage safeArea="bottom" testID="shares-screen">
        {phase === 'no-server' || phase === 'signed-out' ? (
          <EmptyState image={illustrations.emptyVault} title={t('mobileUI.sharingConnect')}
            detail={phase === 'signed-out' ? message : t('mobileUI.sharingConnectBody')} />
        ) : phase === 'starting' ? (
          <Progress testID="shares-status" label={message} />
        ) : (
          <InlineError testID="shares-status">{message}</InlineError>
        )}
        {error && !stepUpFor && <InlineError testID="shares-error">{error}</InlineError>}
        {needsStepUp && !stepUpFor ? (
          <AppButton testID="share-stepup-start" label={t('shares.verifyItsYou')} onPress={() => setStepUpFor(() => () => setStartAttempt(n => n + 1))} />
        ) : null}
        {phase === 'failed' && !needsStepUp && !stepUpFor && (
          <AppButton variant="secondary" label={t('security.retry')} disabled={busy} onPress={() => setStartAttempt(value => value + 1)} />
        )}
        {phase === 'failed' && startError?.kind === 'identity' && !stepUpFor ? (
          <AppButton testID="share-reset-key" variant="text" label={t('shares.resetKey')} disabled={busy} onPress={confirmResetIdentity} />
        ) : null}
        {stepUpPanel}
      </AppPage>
    );
  }

  const incoming = shares.filter(share => share.role === 'recipient');
  const outgoing = shares.filter(share => share.role === 'owner');
  const changeSection = (value: string) => {
    setSection(value as ShareSection);
    setOpened(null);
    setDraft(null);
    setRevealed(false);
  };
  const options: Array<{ value: ShareSection; label: string }> = [
    { value: 'overview', label: t('mobileUI.sharingOverview') },
    { value: 'inbox', label: t('shares.sharedWithMe') },
    { value: 'sent', label: t('shares.sharedByMe') },
    { value: 'new', label: t('shares.shareItem') },
    { value: 'identity', label: t('mobileUI.verifyContacts') },
  ];
  const shownName = (name: string) => (dict.fields as Record<string, string>)[name] ?? name;
  const contactVerification = (
    <FormSection title={t('mobileUI.verifyContacts')}>
      <AppTextField label={t('shares.recipientEmail')} testID="share-recipient" value={email} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email"
        onChangeText={value => { setEmail(value); setContact(null); setNotFound(false); }} />
      <AppButton testID="share-lookup" variant="secondary" label={t('shares.lookUp')} loading={busy} disabled={!email.trim()} onPress={lookUp} />
      {notFound && <InlineError>{t('shares.noSuchRecipient')}</InlineError>}
      {contact && (
        <>
          <Text style={[textStyle.helper, { color: colors.muted }]}>{t('shares.serverFingerprint', contact.email)}</Text>
          <Text testID="recipient-fingerprint" style={[textStyle.body, mono, { color: colors.text }]}>{contact.fingerprint}</Text>
          {contact.pinState === 'verified' && <Text style={[textStyle.helper, { color: colors.okText }]}>{t('shares.verified')}</Text>}
          {contact.pinState === 'unverified' && (
            <>
              <Text style={[textStyle.helper, { color: colors.muted }]}>{t('shares.verifyInstructions', contact.email)}</Text>
              <AppButton testID="share-verify" label={t('shares.digitsMatch')} disabled={busy} onPress={() => verifyContact(contact)} />
            </>
          )}
          {(contact.pinState === 'changed' || contact.pinState === 'relabeled') && (
            <>
              <InlineError>{contact.pinState === 'relabeled'
                ? t('shares.relabeled', contact.email, contact.pinnedEmail ?? '—')
                : t('shares.keyChanged', contact.pinnedFingerprint ?? '—', contact.email)}</InlineError>
              <AppButton testID="share-forget" variant="secondary" label={t('shares.forgetAndReverify')} disabled={busy} onPress={() => forgetContact(contact.user_id)} />
            </>
          )}
        </>
      )}
    </FormSection>
  );

  function renderShare(share: ShareSummary) {
    if (!session) return null;
    const actions = shareActions(share);
    const peer = session.peerView(share);
    const recipient = share.role === 'recipient';
    const removeLabel = recipient ? t(share.status === 'pending' ? 'shares.decline' : 'shares.leave') : t('shares.revoke');
    return (
      <FormSection key={share.id}
        title={t(recipient ? 'shares.from' : 'shares.to', peerLabel(peer))}
        description={meta(share)}>
        {actions.canRevoke && blocked(peer) ? peerWarning(share, peer) : null}
        {recipient && actions.canAccept && peer.state === 'unverified' && (
          verifyingId === share.id ? (
            <>
              <Text style={[textStyle.helper, { color: colors.muted }]}>{t('shares.serverFingerprint', peer.serverEmail)}</Text>
              <Text style={[textStyle.body, mono, { color: colors.text }]}>{peerFingerprints[share.id]}</Text>
              <Text style={[textStyle.helper, { color: colors.muted }]}>{t('shares.verifyInstructions', peer.serverEmail)}</Text>
              <AppButton testID={`verify-owner-confirm-${share.id}`} label={t('shares.digitsMatch')} disabled={busy} onPress={() => verifyOwner(share)} />
              <AppButton testID={`verify-owner-cancel-${share.id}`} variant="secondary" label={t('shares.cancel')} onPress={() => setVerifyingId(null)} />
            </>
          ) : <AppButton testID={`verify-owner-${share.id}`} variant="secondary" label={t('shares.verifyOwner', peer.serverEmail)} onPress={() => setVerifyingId(share.id)} />
        )}
        {recipient && actions.canAccept && peer.state === 'verified' && (
          <AppButton testID={`accept-${share.id}`} label={t('shares.accept')} disabled={busy} onPress={() => accept(share)} />
        )}
        {actions.canOpen && peer.state === 'verified' && (
          <AppButton testID={`open-${share.id}`} variant="secondary" label={t('shares.open')} disabled={busy} onPress={() => open(share)} />
        )}
        {!recipient && actions.canEdit && peer.state === 'verified' && (
          <AppButton testID={`send-latest-${share.id}`} variant="secondary" label={t('shares.sendLatest')} disabled={busy} onPress={() => sendLatest(share)} />
        )}
        {actions.canRevoke && (
          <AppButton testID={`${recipient ? 'leave' : 'revoke-share'}-${share.id}`} variant="text" label={removeLabel}
            disabled={busy} onPress={() => confirmRevoke(share, recipient ? removeLabel : t('shares.confirmRevoke'))} />
        )}
      </FormSection>
    );
  }

  return (
    <AppPage safeArea="bottom" testID="shares-screen">
      {notice && <Text testID="shares-notice" accessibilityLiveRegion="polite" style={[textStyle.helper, { color: colors.okText }]}>{notice}</Text>}
      {error && !stepUpFor && <InlineError testID="shares-error">{error}</InlineError>}
      {stepUpPanel}
      <SelectField label={t('mobileUI.sharingSection')} testID="shares-section" value={section} choices={options} onChange={changeSection} compact />
      {!opened && section === 'overview' && (
        <Group>
          <SettingsRow icon="share" label={t('shares.shareItem')} navigation onPress={() => changeSection('new')} />
          <Rule leading />
          <SettingsRow icon="import" label={t('shares.sharedWithMe')} value={String(incoming.length)} navigation onPress={() => changeSection('inbox')} />
          <Rule leading />
          <SettingsRow icon="export" label={t('shares.sharedByMe')} value={String(outgoing.length)} navigation onPress={() => changeSection('sent')} />
          <Rule leading />
          <SettingsRow icon="security" label={t('mobileUI.verifyContacts')} navigation onPress={() => changeSection('identity')} />
        </Group>
      )}
      {!opened && section === 'identity' && (
        <>
          <FormSection title={t('shares.myKey')} description={t('shares.myKeyHelp')}>
            <Text testID="my-fingerprint" selectable style={[textStyle.body, mono, { color: colors.text }]}>{myFingerprint}</Text>
            <AppButton testID="share-reset-key" variant="secondary" label={t('shares.resetKey')} disabled={busy || Boolean(stepUpFor)} onPress={confirmResetIdentity} />
          </FormSection>
          {contactVerification}
          {contact?.pinState === 'verified' && <AppButton variant="secondary" label={t('shares.shareItem')} onPress={() => changeSection('new')} />}
        </>
      )}
      {!opened && section === 'new' && (
        <>
          <SelectField testID="share-item" label={t('shares.item')} value={itemId} choices={items.map(item => ({ value: item.id, label: item.title }))} onChange={setItemId} />
          {contactVerification}
          <FormSection>
            <SegmentedControl testID="share-permission" label={t('shares.permission')} value={permission}
              choices={[{ value: 'read', label: t('shares.permRead') }, { value: 'write', label: t('shares.permWrite') }]} onChange={value => setPermission(value === 'write' ? 'write' : 'read')} />
            <SelectField testID="share-expiry" label={t('shares.expiry')} value={expiry}
              choices={EXPIRIES.map(value => ({ value, label: value === 'never' ? t('shares.expiryNever') : t(`shares.expiry${value}`) }))}
              onChange={value => setExpiry(value as Expiry)} compact />
            <AppButton testID="create-share-button" label={t('shares.share')} icon="share" loading={busy} disabled={!itemId || contact?.pinState !== 'verified'} onPress={doShare} />
          </FormSection>
        </>
      )}
      {!opened && (section === 'inbox' || section === 'sent') && (
        <PageSection>
          {(section === 'inbox' ? incoming : outgoing).length
            ? (section === 'inbox' ? incoming : outgoing).map(renderShare)
            : <EmptyState title={t('shares.none')} />}
          {section === 'sent' && <Text style={[textStyle.helper, { color: colors.muted }]}>{t('shares.revokeLimit')}</Text>}
        </PageSection>
      )}
      {opened && (
        <FormSection title={opened.data.item.title} description={`${t('shares.revision', opened.data.revision)} · ${t(opened.data.lastWriter === 'recipient' ? 'shares.lastWriterRecipient' : 'shares.lastWriterOwner')}`}>
          {draft ? (
            <>
              <FieldGroup>
                <AppTextField label={t('shares.item')} testID="share-edit-title" flush value={draft.title} onChangeText={value => setDraft({ ...draft, title: value })} />
                {Object.entries(draft.fields).map(([name, value]) => {
                  const secret = /password|secret|card_number|account_number|private_key|^key$/i.test(name);
                  return (
                    <AppTextField key={name} label={shownName(name)} testID={`share-edit-${name}`} flush value={value} autoCapitalize="none" autoCorrect={false}
                      secureTextEntry={secret && !revealed} revealable={secret && !revealed}
                      onChangeText={next => setDraft({ ...draft, fields: { ...draft.fields, [name]: next } })} />
                  );
                })}
              </FieldGroup>
              <AppButton testID="share-edit-save" label={t('shares.saveChanges')} loading={busy} onPress={saveDraft} />
              <AppButton testID="share-edit-cancel" variant="secondary" label={t('shares.cancel')} onPress={() => setDraft(null)} />
            </>
          ) : (
            <>
              <Group>
                {Object.entries(opened.data.item.fields).map(([name, value], index) => (
                  <React.Fragment key={name}>
                    {index > 0 && <Rule />}
                    <SettingsRow label={shownName(name)} detail={revealed ? (typeof value === 'string' ? value : JSON.stringify(value)) : '••••••••'} />
                  </React.Fragment>
                ))}
              </Group>
              <AppButton testID="share-reveal" variant="secondary" icon={revealed ? 'hide' : 'show'} label={t(revealed ? 'shares.hide' : 'shares.reveal')} onPress={() => setRevealed(value => !value)} />
              {shareActions(opened.share).canEdit && (
                <AppButton testID="share-edit" variant="secondary" label={t('shares.edit')} onPress={() => setDraft({
                  title: opened.data.item.title,
                  fields: Object.fromEntries(Object.entries(opened.data.item.fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
                })} />
              )}
              {opened.share.role === 'owner' && opened.data.lastWriter === 'recipient' && (
                <AppButton testID="share-save-to-vault" label={t('shares.saveToVault')} loading={busy} onPress={saveToVault} />
              )}
            </>
          )}
          <AppButton testID="share-close" variant="text" label={t('shares.close')} onPress={() => { setOpened(null); setDraft(null); setRevealed(false); }} />
        </FormSection>
      )}
    </AppPage>
  );
}

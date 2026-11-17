import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import StepUpDialog from './StepUpDialog';

/**
 * SharesView — end-to-end encrypted item sharing (desktop + web).
 * Protocol and limits: specs/sharing-protocol.md. All crypto runs in
 * packages/core/src/sharing.ts via SharingSession (packages/sdk/src/sharing.ts).
 *
 *  - "Your sharing key" shows the fingerprint derived from the locally
 *    decrypted identity — never one the server reports.
 *  - Sharing needs the recipient's key to be verified (fingerprint compared
 *    out of band, then pinned on this device with the email it was verified
 *    under). Names shown for a verified contact are the PINNED emails; an
 *    unverified email is labelled as what the server says. A changed key, or
 *    a pinned key the server now labels with another email, blocks the
 *    action with a warning; the only way on is forget + re-verify.
 *  - Accept runs the key-exchange check (owner key pinned, wrap opens and is
 *    bound to this share) and only then calls the server.
 *  - Recipient edits never enter the owner's vault by themselves: the owner
 *    saves exactly the revision they reviewed.
 *  - Creating or resetting the sharing key needs a server step-up (passkey
 *    or TOTP via StepUpDialog). Resetting ends every share.
 *  - Revoke states its limit next to the button: already-seen data cannot be
 *    erased from the recipient's device.
 * Without a configured server or a session, the view says so and does nothing.
 */

export interface SharesViewProps {
  /** API base URL; empty = local-only, sharing unavailable. */
  apiBaseUrl: string;
  signedIn: boolean;
  getToken: () => Promise<string | null>;
  /** Live (non-trashed) vault items. */
  items: VaultItem[];
  encryptWithVaultKey: (plaintext: string) => Promise<string>;
  decryptWithVaultKey: (encoded: string) => Promise<string | null>;
  /** Persist an item into the vault (upsert) and refresh the app's list. */
  onSaveItem: (item: VaultItem) => Promise<void>;
  onUnauthorized?: () => void;
}

type Expiry = '1' | '7' | '30' | 'never';

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
};

function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export default function SharesView(props: SharesViewProps) {
  const { t } = useTranslation();
  const latest = useRef(props);
  latest.current = props;

  const [session, setSession] = useState<SharingSession | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  const [startError, setStartError] = useState<{ kind: ShareErrorKind; detail: string } | null>(null);
  const [stepUpFor, setStepUpFor] = useState<null | (() => void)>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [myFingerprint, setMyFingerprint] = useState('');
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [peerFingerprints, setPeerFingerprints] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

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
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const baseUrl = props.apiBaseUrl.trim();
  const canStart = baseUrl !== '' && props.signedIn;

  const security = useMemo(
    () => (baseUrl ? new SecurityApiClient({ baseUrl, getToken: () => latest.current.getToken() }) : null),
    [baseUrl],
  );

  const sessionOptions = useCallback((): SharingSessionOptions => ({
    api: new SharingApiClient({ baseUrl, getToken: () => latest.current.getToken() }),
    vault: {
      encrypt: (p) => latest.current.encryptWithVaultKey(p),
      decrypt: (c) => latest.current.decryptWithVaultKey(c),
    },
    pinStorage: localStorage,
    items: {
      find: (id) => latest.current.items.find((i) => i.id === id),
      save: (item) => latest.current.onSaveItem(item),
    },
  }), [baseUrl]);

  const report = useCallback((e: unknown) => {
    const c = classifyShareError(e);
    if (c.kind === 'unauthorized') {
      latest.current.onUnauthorized?.();
      return;
    }
    const key = ERROR_KEYS[c.kind];
    setNotice('');
    if (key) setError(t(key));
    else if (c.kind === 'identity') setError(t('shares.unavailable', c.detail));
    else if (c.kind === 'invalid_content') setError(t('shares.errorInvalidContent', c.detail));
    else setError(t('shares.errorGeneric', c.detail));
  }, [t]);

  // Start (or restart after a step-up) the session. Registering a first
  // identity answers 403 step_up_required until the user verifies.
  useEffect(() => {
    if (!canStart) return undefined;
    let cancelled = false;
    let started: SharingSession | null = null;
    setStartError(null);
    void (async () => {
      try {
        const s = await SharingSession.start(sessionOptions());
        if (cancelled) {
          s.close();
          return;
        }
        started = s;
        setMyFingerprint(await s.myFingerprint());
        setSession(s);
      } catch (e) {
        if (cancelled) return;
        const c = classifyShareError(e);
        if (c.kind === 'unauthorized') latest.current.onUnauthorized?.();
        else setStartError(c);
      }
    })();
    return () => {
      cancelled = true;
      started?.close();
      setSession(null);
    };
  }, [canStart, sessionOptions, startAttempt]);

  const refresh = useCallback(async (s: SharingSession) => {
    const list = await s.listShares();
    const fps: Record<string, string> = {};
    for (const share of list) fps[share.id] = await fingerprintOf(sharePeer(share).publicKey);
    setShares(list);
    setPeerFingerprints(fps);
  }, []);

  useEffect(() => {
    if (session) refresh(session).catch(report);
  }, [session, refresh, report]);

  const run = (fn: (s: SharingSession) => Promise<void>) => {
    if (!session || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    fn(session).catch(report).finally(() => setBusy(false));
  };

  /** Reset the identity (needs step-up). Replaces the running session. */
  const resetIdentity = () => {
    setBusy(true);
    setError('');
    setNotice('');
    SharingSession.resetIdentity(sessionOptions())
      .then(async (s) => {
        session?.close();
        setConfirmReset(false);
        setStartError(null);
        setMyFingerprint(await s.myFingerprint());
        setSession(s);
        setNotice(t('shares.resetDone'));
      })
      .catch((e) => {
        if (classifyShareError(e).kind === 'step_up') setStepUpFor(() => resetIdentity);
        else report(e);
      })
      .finally(() => setBusy(false));
  };

  // --- owner: share an item ---------------------------------------------------
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
    const item = props.items.find((i) => i.id === itemId);
    if (!item || !contact) return;
    await s.shareItem({ item, contact, permission, expiresAt: expiresAtFor(expiry) });
    setNotice(t('shares.shared', contact.email));
    setContact(null);
    setEmail('');
    await refresh(s);
  });

  // --- both roles ---------------------------------------------------------------
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
  const revoke = (share: ShareSummary) => run(async (s) => {
    await s.revokeShare(share);
    setConfirmRevokeId(null);
    if (opened?.share.id === share.id) setOpened(null);
    setNotice(t('shares.revoked'));
    await refresh(s);
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

  // --- rendering ---------------------------------------------------------------
  const statusLabel = (share: ShareSummary) => {
    if (share.status === 'revoked') return t('shares.statusRevoked');
    if (share.expired) return t('shares.statusExpired');
    return share.status === 'active' ? t('shares.statusActive') : t('shares.statusPending');
  };
  const meta = (share: ShareSummary) => [
    share.permission === 'write' ? t('shares.permWrite') : t('shares.permRead'),
    statusLabel(share),
    share.expires_at ? t('shares.expiresOn', new Date(share.expires_at).toLocaleString()) : t('shares.noExpiry'),
    t('shares.revision', share.revision),
  ].join(' · ');
  /** Verified peers by their PINNED email; anyone else as "the server says". */
  const peerLabel = (peer: PeerView) => (peer.state === 'verified' ? peer.email : t('shares.serverSays', peer.serverEmail));
  const blocked = (peer: PeerView) => peer.state === 'changed' || peer.state === 'relabeled';

  const peerWarning = (share: ShareSummary, peer: PeerView) => (
    <div className="mt-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200" role="alert">
      {peer.state === 'relabeled'
        ? <p>{t('shares.relabeled', peer.serverEmail, peer.pinnedEmail ?? '—')}</p>
        : <p>{t('shares.keyChanged', peer.pinnedFingerprint ?? '—', peer.pinnedEmail ?? peer.serverEmail)}</p>}
      <p className="mt-1 font-mono">{peerFingerprints[share.id]}</p>
      <button className="btn-ghost mt-2 !py-1 text-xs" disabled={busy} onClick={() => forgetContact(peer.userId)}>{t('shares.forgetAndReverify')}</button>
    </div>
  );

  const revokeControls = (share: ShareSummary, label: string) => (
    confirmRevokeId === share.id ? (
      <span className="flex gap-2">
        <button className="btn-ghost !py-1 text-xs" onClick={() => setConfirmRevokeId(null)}>{t('shares.cancel')}</button>
        <button className="btn-primary !py-1 text-xs" disabled={busy} onClick={() => revoke(share)}>{share.role === 'owner' ? t('shares.confirmRevoke') : label}</button>
      </span>
    ) : (
      <button className="btn-ghost !py-1 text-xs" onClick={() => setConfirmRevokeId(share.id)}>{label}</button>
    )
  );

  const resetControls = (
    confirmReset ? (
      <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
        <p>{t('shares.resetKeyWarning')}</p>
        <div className="mt-2 flex gap-2">
          <button className="btn-primary !py-1 text-xs" disabled={busy} onClick={resetIdentity}>{t('shares.confirmReset')}</button>
          <button className="btn-ghost !py-1 text-xs" onClick={() => setConfirmReset(false)}>{t('shares.cancel')}</button>
        </div>
      </div>
    ) : (
      <button className="btn-ghost mt-3 !py-1 text-xs" onClick={() => setConfirmReset(true)}>{t('shares.resetKey')}</button>
    )
  );

  const stepUpDialog = (
    <StepUpDialog
      open={stepUpFor !== null}
      security={security}
      serverOnly
      onVerified={() => {
        const next = stepUpFor;
        setStepUpFor(null);
        next?.();
      }}
      onCancel={() => setStepUpFor(null)}
    />
  );

  if (!baseUrl || !props.signedIn) {
    return (
      <div className="p-5">
        <h2 className="text-base font-semibold">{t('shares.title')}</h2>
        <p className="mt-2 text-sm text-zinc-400">{baseUrl ? t('shares.signedOut') : t('shares.notConfigured')}</p>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="p-5">
        <h2 className="text-base font-semibold">{t('shares.title')}</h2>
        {error && <p className="mt-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200" role="alert">{error}</p>}
        {!startError && <p className="mt-2 text-sm text-zinc-400">{t('shares.starting')}</p>}
        {startError?.kind === 'step_up' && (
          <div className="card mt-3 p-4">
            <p className="text-sm text-zinc-300">{t('shares.stepUpNeeded')}</p>
            <button className="btn-primary mt-3" onClick={() => setStepUpFor(() => () => setStartAttempt((n) => n + 1))}>{t('shares.verifyItsYou')}</button>
          </div>
        )}
        {startError && startError.kind !== 'step_up' && (
          <div className="mt-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            <p>{t('shares.unavailable', startError.detail)}</p>
            {startError.kind === 'identity' && resetControls}
          </div>
        )}
        {stepUpDialog}
      </div>
    );
  }

  const incoming = shares.filter((s) => s.role === 'recipient');
  const outgoing = shares.filter((s) => s.role === 'owner');
  const selectedItem = props.items.find((i) => i.id === itemId);

  return (
    <div className="p-5">
      <h2 className="text-base font-semibold">{t('shares.title')}</h2>
      <p className="mt-1 text-sm text-zinc-400">{t('shares.intro')}</p>
      {notice && <p className="mt-3 rounded-lg border border-emerald-900/60 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200" role="status">{notice}</p>}
      {error && <p className="mt-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200" role="alert">{error}</p>}

      <section className="card mt-4 p-4" aria-label={t('shares.myKey')}>
        <h3 className="text-sm font-semibold">{t('shares.myKey')}</h3>
        <p className="mt-2 font-mono text-lg tracking-wider text-zinc-100" data-testid="my-fingerprint">{myFingerprint}</p>
        <p className="mt-1 text-xs text-zinc-400">{t('shares.myKeyHelp')}</p>
        {resetControls}
      </section>

      <section className="card mt-4 p-4" aria-label={t('shares.shareItem')}>
        <h3 className="text-sm font-semibold">{t('shares.shareItem')}</h3>
        <div className="mt-3 space-y-3">
          <div>
            <label className="label" htmlFor="share-item">{t('shares.item')}</label>
            <select id="share-item" className="input" value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">{t('shares.chooseItem')}</option>
              {props.items.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="share-recipient">{t('shares.recipientEmail')}</label>
            <div className="flex gap-2">
              <input id="share-recipient" type="email" className="input" value={email} autoComplete="off"
                onChange={(e) => { setEmail(e.target.value); setContact(null); setNotFound(false); }} />
              <button className="btn-ghost" disabled={busy || !email.trim()} onClick={lookUp}>{t('shares.lookUp')}</button>
            </div>
            {notFound && <p className="mt-2 text-sm text-zinc-400">{t('shares.noSuchRecipient')}</p>}
          </div>

          {contact && (
            <div className="rounded-lg border border-zinc-800 p-3">
              <p className="text-xs text-zinc-400">{t('shares.serverFingerprint', contact.email)}</p>
              <p className="mt-1 font-mono text-base tracking-wider text-zinc-100" data-testid="recipient-fingerprint">{contact.fingerprint}</p>
              {contact.pinState === 'verified' && <p className="mt-2 text-sm text-emerald-300">{t('shares.verified')}</p>}
              {contact.pinState === 'unverified' && (
                <div className="mt-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
                  <p>{t('shares.verifyInstructions', contact.email)}</p>
                  <div className="mt-2 flex gap-2">
                    <button className="btn-primary !py-1 text-xs" disabled={busy} onClick={() => verifyContact(contact)}>{t('shares.digitsMatch')}</button>
                    <button className="btn-ghost !py-1 text-xs" onClick={() => setContact(null)}>{t('shares.cancel')}</button>
                  </div>
                </div>
              )}
              {(contact.pinState === 'changed' || contact.pinState === 'relabeled') && (
                <div className="mt-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200" role="alert">
                  {contact.pinState === 'relabeled'
                    ? <p>{t('shares.relabeled', contact.email, contact.pinnedEmail ?? '—')}</p>
                    : <p>{t('shares.keyChanged', contact.pinnedFingerprint ?? '—', contact.email)}</p>}
                  <button className="btn-ghost mt-2 !py-1 text-xs" disabled={busy} onClick={() => forgetContact(contact.user_id)}>{t('shares.forgetAndReverify')}</button>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <div className="min-w-[14rem] flex-1">
              <label className="label" htmlFor="share-permission">{t('shares.permission')}</label>
              <select id="share-permission" className="input" value={permission} onChange={(e) => setPermission(e.target.value as SharePermission)}>
                <option value="read">{t('shares.permRead')}</option>
                <option value="write">{t('shares.permWrite')}</option>
              </select>
            </div>
            <div className="min-w-[10rem]">
              <label className="label" htmlFor="share-expiry">{t('shares.expiry')}</label>
              <select id="share-expiry" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                <option value="1">{t('shares.expiry1')}</option>
                <option value="7">{t('shares.expiry7')}</option>
                <option value="30">{t('shares.expiry30')}</option>
                <option value="never">{t('shares.expiryNever')}</option>
              </select>
            </div>
          </div>
          <button className="btn-primary" disabled={busy || !selectedItem || contact?.pinState !== 'verified'} onClick={doShare}>{t('shares.share')}</button>
        </div>
      </section>

      <section className="mt-6" aria-label={t('shares.sharedWithMe')}>
        <h3 className="text-sm font-semibold">{t('shares.sharedWithMe')}</h3>
        {incoming.length === 0 ? <p className="mt-2 text-sm text-zinc-500">{t('shares.none')}</p> : (
          <ul className="mt-2 space-y-2">
            {incoming.map((share) => {
              const actions = shareActions(share);
              const peer = session.peerView(share);
              return (
                <li key={share.id} className="card p-3">
                  <p className="text-sm font-semibold text-zinc-100">{t('shares.from', peerLabel(peer))}</p>
                  <p className="text-xs text-zinc-400">{meta(share)}</p>
                  {actions.canRevoke && blocked(peer) && peerWarning(share, peer)}
                  {actions.canAccept && peer.state === 'unverified' && (
                    verifyingId === share.id ? (
                      <div className="mt-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
                        <p className="text-xs">{t('shares.serverFingerprint', peer.serverEmail)}</p>
                        <p className="mt-1 font-mono tracking-wider">{peerFingerprints[share.id]}</p>
                        <p className="mt-1">{t('shares.verifyInstructions', peer.serverEmail)}</p>
                        <div className="mt-2 flex gap-2">
                          <button className="btn-primary !py-1 text-xs" disabled={busy} onClick={() => verifyOwner(share)}>{t('shares.digitsMatch')}</button>
                          <button className="btn-ghost !py-1 text-xs" onClick={() => setVerifyingId(null)}>{t('shares.cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      <button className="btn-ghost mt-2 !py-1 text-xs" onClick={() => setVerifyingId(share.id)}>{t('shares.verifyOwner', peer.serverEmail)}</button>
                    )
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {actions.canAccept && peer.state === 'verified' && <button className="btn-primary !py-1 text-xs" disabled={busy} onClick={() => accept(share)}>{t('shares.accept')}</button>}
                    {actions.canOpen && peer.state === 'verified' && <button className="btn-ghost !py-1 text-xs" disabled={busy} onClick={() => open(share)}>{t('shares.open')}</button>}
                    {actions.canRevoke && revokeControls(share, share.status === 'pending' ? t('shares.decline') : t('shares.leave'))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-6" aria-label={t('shares.sharedByMe')}>
        <h3 className="text-sm font-semibold">{t('shares.sharedByMe')}</h3>
        {outgoing.length === 0 ? <p className="mt-2 text-sm text-zinc-500">{t('shares.none')}</p> : (
          <ul className="mt-2 space-y-2">
            {outgoing.map((share) => {
              const actions = shareActions(share);
              const peer = session.peerView(share);
              return (
                <li key={share.id} className="card p-3">
                  <p className="text-sm font-semibold text-zinc-100">{t('shares.to', peerLabel(peer))}</p>
                  <p className="text-xs text-zinc-400">{meta(share)}</p>
                  {actions.canRevoke && blocked(peer) && peerWarning(share, peer)}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {actions.canOpen && peer.state === 'verified' && <button className="btn-ghost !py-1 text-xs" disabled={busy} onClick={() => open(share)}>{t('shares.open')}</button>}
                    {actions.canEdit && peer.state === 'verified' && <button className="btn-ghost !py-1 text-xs" disabled={busy} onClick={() => sendLatest(share)}>{t('shares.sendLatest')}</button>}
                    {actions.canRevoke && revokeControls(share, t('shares.revoke'))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-xs text-zinc-500">{t('shares.revokeLimit')}</p>
      </section>

      {opened && (
        <section className="card mt-6 p-4" aria-label={opened.data.item.title}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">{opened.data.item.title}</h3>
              <p className="text-xs text-zinc-400">
                {t('shares.revision', opened.data.revision)} · {opened.data.lastWriter === 'recipient' ? t('shares.lastWriterRecipient') : t('shares.lastWriterOwner')}
              </p>
            </div>
            <button className="btn-ghost !py-1 text-xs" onClick={() => { setOpened(null); setDraft(null); }}>{t('shares.close')}</button>
          </div>
          {draft ? (
            <div className="mt-3 space-y-2">
              <input className="input" aria-label={t('shares.item')} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              {Object.entries(draft.fields).map(([name, value]) => (
                <div key={name}>
                  <label className="label" htmlFor={`share-field-${name}`}>{name}</label>
                  <input id={`share-field-${name}`} className="input" value={value} autoComplete="off"
                    onChange={(e) => setDraft({ ...draft, fields: { ...draft.fields, [name]: e.target.value } })} />
                </div>
              ))}
              <div className="flex gap-2">
                <button className="btn-primary !py-1 text-xs" disabled={busy} onClick={saveDraft}>{t('shares.saveChanges')}</button>
                <button className="btn-ghost !py-1 text-xs" onClick={() => setDraft(null)}>{t('shares.cancel')}</button>
              </div>
            </div>
          ) : (
            <>
              <dl className="mt-3 space-y-1 text-sm">
                {Object.entries(opened.data.item.fields).map(([name, value]) => (
                  <div key={name} className="flex gap-3">
                    <dt className="w-40 shrink-0 text-zinc-400">{name}</dt>
                    <dd className="min-w-0 break-all font-mono text-zinc-100">{revealed ? displayValue(value) : '••••••••'}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn-ghost !py-1 text-xs" onClick={() => setRevealed((v) => !v)}>{revealed ? t('shares.hide') : t('shares.reveal')}</button>
                {shareActions(opened.share).canEdit && (
                  <button className="btn-ghost !py-1 text-xs" onClick={() => setDraft({
                    title: opened.data.item.title,
                    fields: Object.fromEntries(Object.entries(opened.data.item.fields).filter((e): e is [string, string] => typeof e[1] === 'string')),
                  })}>{t('shares.edit')}</button>
                )}
                {opened.share.role === 'owner' && opened.data.lastWriter === 'recipient' && (
                  <button className="btn-primary !py-1 text-xs" disabled={busy} onClick={saveToVault}>{t('shares.saveToVault')}</button>
                )}
              </div>
            </>
          )}
        </section>
      )}
      {stepUpDialog}
    </div>
  );
}

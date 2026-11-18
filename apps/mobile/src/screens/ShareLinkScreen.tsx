import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Share } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import type { VaultItem } from '../../../../packages/core/src/types';
import { createShareLink, shareLinkSnapshot, shareLinkURL } from '../../../../packages/core/src/share-link';
import { ApiError } from '../../../../packages/sdk/src/index';
import { ShareLinksApiClient, type OwnedShareLink } from '../../../../packages/sdk/src/share-links';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { AppButton, AppPage, FormSection, Group, IconButton, InlineError, PageSection, Progress, Rule, SelectField, SettingsRow } from '../components/mobile-ui';
import { decryptWithVaultKey, encryptWithVaultKey } from '../vault';
import { getApiToken } from './SecurityScreen';
import { SHARE_WEB_ORIGIN_KEY } from '../accountServer';

interface LinkView { link: OwnedShareLink; url: string }
export default function ShareLinkScreen({ item, baseUrl, onUnauthorized }: { item: VaultItem; baseUrl: string; onUnauthorized: (itemId: string) => void }) {
  const { t, dict, locale } = useTranslation();
  const [ttl, setTTL] = useState('86400'); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [api, setApi] = useState<ShareLinksApiClient | null>(null);
  const [origin, setOrigin] = useState(''); const [url, setURL] = useState(''); const [copied, setCopied] = useState(false);
  const [links, setLinks] = useState<LinkView[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const fields = useMemo(() => {
    try { return Object.keys(shareLinkSnapshot(item).fields); }
    catch { return null; }
  }, [item]);
  function handleRequestError(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) {
      onUnauthorized(item.id);
    } else {
      setError(t('mobileUI.linkFailed'));
    }
  }
  async function refresh(client: ShareLinksApiClient, webOrigin: string) {
    const result = await client.list(); const found: LinkView[] = [];
    for (const link of result.links) {
      if (link.revoked_at || Date.parse(link.expires_at) <= Date.now() || !link.encrypted_owner_metadata) continue;
      try {
        const plain = await decryptWithVaultKey(link.encrypted_owner_metadata);
        const metadata = JSON.parse(plain ?? 'null');
        if (metadata?.kind === 'my-secrect.share-link.owner.v1' && metadata.id === link.id && metadata.item_id === item.id) found.push({ link, url: shareLinkURL(webOrigin, link.id, metadata.secret) });
      } catch { /* Different vault key: never display or guess ownership metadata. */ }
    }
    setLinks(found);
  }
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    void (async () => {
      if (!(await getApiToken())) { if (alive) onUnauthorized(item.id); return; }
      const override = __DEV__ ? (await AsyncStorage.getItem(SHARE_WEB_ORIGIN_KEY))?.trim() : '';
      const webOrigin = override || new URL(baseUrl).origin;
      const client = new ShareLinksApiClient({ baseUrl, getToken: getApiToken });
      if (!alive) return;
      setApi(client); setOrigin(webOrigin);
      await refresh(client, webOrigin);
    })().catch(cause => { if (alive) handleRequestError(cause); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [baseUrl, item.id, onUnauthorized, retry]);
  async function create() {
    if (!api || busy || !fields) return;
    setBusy(true); setError(''); setCopied(false);
    try {
      const value = await createShareLink(item, Number(ttl));
      // Validate the trusted origin before storing anything on the server.
      const nextURL = shareLinkURL(origin, value.record.id, value.secret);
      const metadata = await encryptWithVaultKey(JSON.stringify({ kind: 'my-secrect.share-link.owner.v1', id: value.record.id, item_id: item.id, secret: value.secret }));
      await api.create(value.record, metadata);
      setURL(nextURL); await refresh(api, origin);
    } catch (cause) { handleRequestError(cause); } finally { setBusy(false); }
  }
  function revoke(id: string) {
    Alert.alert(t('mobileUI.revokeLinkTitle'), t('mobileUI.revokeLinkBody'), [
      { text: dict.common.cancel, style: 'cancel' }, { text: t('mobileUI.revokeLink'), style: 'destructive', onPress: () => {
        setBusy(true); void api?.revoke(id).then(async () => { setURL(''); await refresh(api, origin); }).catch(handleRequestError).finally(() => setBusy(false));
      } },
    ]);
  }
  const when = (value: string) => new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const choices = [
    { value: '3600', label: t('mobileUI.hour') },
    { value: '86400', label: t('mobileUI.day') },
    { value: '604800', label: t('mobileUI.week') },
  ];
  const fieldLabel = (name: string) => (dict.fields as Record<string, string>)[name] ?? name;

  return (
    <AppPage safeArea="bottom" testID="share-link-screen">
      <PageSection title={item.title} description={t('mobileUI.linkRetention')}>
        {loading ? <Progress label={dict.common.loading} /> : null}
        {error ? <InlineError testID="share-link-error">{error}</InlineError> : null}
        {!loading && error && api && <AppButton label={t('security.retry')} variant="text" onPress={() => setRetry(value => value + 1)} />}
      </PageSection>
      {api && !loading && (
        <>
          {!fields ? (
            <InlineError testID="share-link-unsupported">{t('mobileUI.linkFieldsInvalid')}</InlineError>
          ) : fields.length > 0 && (
            <Group title={t('mobileUI.linkFields')}>
              {fields.map((name, index) => (
                <React.Fragment key={name}>{index > 0 && <Rule />}<SettingsRow label={fieldLabel(name)} /></React.Fragment>
              ))}
            </Group>
          )}
          {url ? (
            <FormSection>
              <AppButton testID="copy-share-link" label={copied ? dict.common.copied : t('mobileUI.copyLink')} icon="copy"
                onPress={() => void Clipboard.setStringAsync(url).then(() => setCopied(true)).catch(() => setError(t('mobileUI.clipboardFailed')))} />
              <AppButton testID="send-share-link" label={t('mobileUI.sendLink')} icon="share" variant="secondary"
                onPress={() => void Share.share({ message: url }).catch(() => setError(t('mobileUI.linkFailed')))} />
              <AppButton label={t('mobileUI.createLink')} variant="text" onPress={() => { setURL(''); setCopied(false); }} />
            </FormSection>
          ) : fields && (
            <FormSection>
              <SelectField testID="share-link-expiry" label={t('mobileUI.linkExpiry')} value={ttl} choices={choices} onChange={setTTL} />
              <AppButton testID="create-share-link" label={t('mobileUI.createLink')} icon="link" loading={busy} onPress={() => void create()} />
            </FormSection>
          )}
          {links.length > 0 && (
            <Group title={t('mobileUI.activeLinks')}>
              {links.map(({ link, url: existing }, index) => (
                <React.Fragment key={link.id}>
                  {index > 0 && <Rule />}
                  <SettingsRow testID={`shared-link-${link.id}`} label={t('mobileUI.expiresAt', when(link.expires_at))}
                    onPress={() => { setURL(existing); setCopied(false); }}>
                    <IconButton testID={`revoke-link-${link.id}`} accessibilityLabel={t('mobileUI.revokeLink')} icon="trash" tone="danger" disabled={busy} onPress={() => revoke(link.id)} />
                  </SettingsRow>
                </React.Fragment>
              ))}
            </Group>
          )}
        </>
      )}
    </AppPage>
  );
}

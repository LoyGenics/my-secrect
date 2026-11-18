import React, { useEffect, useState } from 'react';
import { Alert, Share, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { Copy, Share2 } from 'lucide-react-native';
import type { VaultItem } from '../../../../packages/core/src/types';
import { createShareLink, shareLinkURL } from '../../../../packages/core/src/share-link';
import { ShareLinksApiClient, type OwnedShareLink } from '../../../../packages/sdk/src/share-links';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Action, Group, Page, Row, Rule, Select } from '../components/mobile-ui';
import { useMobileTheme } from '../theme';
import { decryptWithVaultKey, encryptWithVaultKey } from '../vault';
import { getApiToken } from './SecurityScreen';
import { SHARE_WEB_ORIGIN_KEY } from '../accountServer';

interface LinkView { link: OwnedShareLink; url: string }
export default function ShareLinkScreen({ item, baseUrl }: { item: VaultItem; baseUrl: string }) {
  const { t, dict, locale } = useTranslation(); const { colors } = useMobileTheme();
  const [ttl, setTTL] = useState('86400'); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [api, setApi] = useState<ShareLinksApiClient | null>(null);
  const [origin, setOrigin] = useState(''); const [url, setURL] = useState(''); const [copied, setCopied] = useState(false);
  const [links, setLinks] = useState<LinkView[]>([]);
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
    void (async () => {
      if (!baseUrl) { if (alive) setError(t('mobileUI.linkConfigure')); return; }
      if (!(await getApiToken())) { if (alive) setError(t('mobileUI.linkConnect')); return; }
      const override = __DEV__ ? (await AsyncStorage.getItem(SHARE_WEB_ORIGIN_KEY))?.trim() : '';
      const webOrigin = override || new URL(baseUrl).origin;
      const client = new ShareLinksApiClient({ baseUrl, getToken: getApiToken });
      if (!alive) return;
      setApi(client); setOrigin(webOrigin);
      try { await refresh(client, webOrigin); } catch { if (alive) setError(t('mobileUI.linkFailed')); }
    })().catch(() => { if (alive) setError(t('mobileUI.linkFailed')); });
    return () => { alive = false; };
  }, [baseUrl, item.id]);
  async function create() {
    if (!api || busy) return;
    setBusy(true); setError(''); setCopied(false);
    try {
      const value = await createShareLink(item, Number(ttl));
      // Validate the trusted origin before storing anything on the server.
      const nextURL = shareLinkURL(origin, value.record.id, value.secret);
      const metadata = await encryptWithVaultKey(JSON.stringify({ kind: 'my-secrect.share-link.owner.v1', id: value.record.id, item_id: item.id, secret: value.secret }));
      await api.create(value.record, metadata);
      setURL(nextURL); await refresh(api, origin);
    } catch { setError(t('mobileUI.linkFailed')); } finally { setBusy(false); }
  }
  function revoke(id: string) {
    Alert.alert(t('mobileUI.revokeLinkTitle'), t('mobileUI.revokeLinkBody'), [
      { text: dict.common.cancel, style: 'cancel' }, { text: t('mobileUI.revokeLink'), style: 'destructive', onPress: () => {
        setBusy(true); void api?.revoke(id).then(async () => { setURL(''); await refresh(api, origin); }).catch(() => setError(t('mobileUI.linkFailed'))).finally(() => setBusy(false));
      } },
    ]);
  }
  const when = (value: string) => new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return <Page>
    <Text style={{ color: colors.text, fontSize: 24, lineHeight: 31, fontWeight: '600', marginBottom: 12 }}>{item.title}</Text>
    <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: 24 }}>{t('mobileUI.linkAnyone')}</Text>
    {!!error && <Text testID="share-link-error" accessibilityRole="alert" style={{ color: colors.dangerText, fontSize: 14, lineHeight: 21, marginBottom: 18 }}>{error}</Text>}
    {url ? <View style={{ gap: 12 }}>
      <Action testID="copy-share-link" label={copied ? dict.common.copied : t('mobileUI.copyLink')} icon={<Copy size={18} color="#FFFFFF" />} onPress={() => void Clipboard.setStringAsync(url).then(() => setCopied(true))} />
      <Action testID="send-share-link" label={t('mobileUI.sendLink')} secondary icon={<Share2 size={18} color={colors.text} />} onPress={() => void Share.share({ message: url })} />
      <Row label={t('mobileUI.createLink')} onPress={() => { setURL(''); setCopied(false); }} />
    </View> : <>
      <Group title={t('mobileUI.linkExpiry')}><View style={{ paddingHorizontal: 16 }}><Select testID="share-link-expiry" label={t('mobileUI.linkExpiry')} value={ttl} choices={[{ value: '3600', label: t('mobileUI.hour') }, { value: '86400', label: t('mobileUI.day') }, { value: '604800', label: t('mobileUI.week') }]} onChange={setTTL} /></View></Group>
      <Action testID="create-share-link" label={busy ? t('mobileUI.creatingLink') : t('mobileUI.createLink')} disabled={!api || busy} onPress={() => void create()} />
    </>}
    {!!links.length && <View style={{ marginTop: 32 }}><Group title={t('mobileUI.activeLinks')}>
      {links.map(({ link, url: existing }, index) => <React.Fragment key={link.id}>{index > 0 && <Rule />}<Row testID={`shared-link-${link.id}`} label={t('mobileUI.expiresAt', when(link.expires_at))} onPress={() => { setURL(existing); setCopied(false); }}>
        <View style={{ flexDirection: 'row' }}><Action testID={`revoke-link-${link.id}`} label={t('mobileUI.revokeLink')} secondary disabled={busy} onPress={() => revoke(link.id)} /></View>
      </Row></React.Fragment>)}
    </Group></View>}
  </Page>;
}

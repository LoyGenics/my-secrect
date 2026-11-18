import { useEffect, useState } from 'react';
import type { VaultItem } from '../../../packages/core/src/types';
import { openShareLink, type ShareLinkRecord } from '../../../packages/core/src/share-link';
import { useTranslation } from '../../../packages/i18n/src/react';
import ghost from '../../../packages/ui/assets/brand/source/ghost-key-cutout.webp';
import './share-page.css';

export default function SharePage({ id }: { id: string }) {
  const { t, dict } = useTranslation();
  const [item, setItem] = useState<VaultItem | null>(null); const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false); const [shown, setShown] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let expiryTimer: ReturnType<typeof setTimeout>;
    void (async () => {
      const key = new URLSearchParams(window.location.hash.slice(1)).get('k') ?? '';
      if (!/^[A-Za-z0-9_-]{32}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('invalid link');
      const response = await fetch(`/api/v1/share-links/${encodeURIComponent(id)}`, { signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('unavailable');
      const { link } = await response.json() as { link: ShareLinkRecord };
      if (link.id !== id) throw new Error('invalid link');
      const opened = await openShareLink(link, key);
      if (controller.signal.aborted) return;
      setItem(opened);
      expiryTimer = setTimeout(() => { setItem(null); setShown({}); setFailed(true); }, Math.max(0, Date.parse(link.expires_at) - Date.now()));
    })().catch(() => { if (!controller.signal.aborted) setFailed(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); clearTimeout(expiryTimer); };
  }, [id]);
  return <main className="share-page">
    <header className="share-brand"><img src={ghost} alt="" /><span>My Secret</span></header>
    <section className="share-card" aria-busy={loading}>
      {loading ? <p role="status">{t('mobileUI.loadShared')}</p> : failed || !item ? <><h1>{t('mobileUI.linkInvalid')}</h1><p>{t('mobileUI.linkInvalidBody')}</p></> : <>
        <h1>{item.title}</h1><p className="share-caption">{t('mobileUI.sharedCopy')}</p>
        <dl>{Object.entries(item.fields).map(([name, raw]) => {
          if (raw == null || raw === '') return null;
          const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
          const secret = /password|secret|key|account_number|card_number|document_number/i.test(name);
          const label = (dict.fields as Record<string, string>)[name] || name.replace(/_/g, ' ');
          return <div className="shared-field" key={name}>
            <dt>{label}</dt><dd><span data-testid={`shared-value-${name}`}>{secret && !shown[name] ? '••••••••••••' : value}</span>
              <div className="share-field-actions">{secret && <button type="button" onClick={() => setShown(s => ({ ...s, [name]: !s[name] }))}>{shown[name] ? dict.itemForm.hide : dict.itemForm.show}</button>}
                <button type="button" data-testid={`shared-copy-${name}`} onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(name)).catch(() => setCopied(''))}>{copied === name ? dict.common.copied : dict.common.copy}</button>
              </div></dd>
          </div>;
        })}</dl>
      </>}
    </section>
  </main>;
}

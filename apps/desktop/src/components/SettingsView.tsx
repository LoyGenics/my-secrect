import { useState } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import CsvImport from './CsvImport';
import FamilyView from './FamilyView';
import {
  Alert,
  Button,
  Card,
  Field,
  Icon,
  Input,
  SecureField,
  SegmentedControl,
  Select,
  Checkbox,
  DEFAULT_THEME_MODE,
  applyTheme,
  getStoredTheme,
  type IconName,
  type ThemeMode,
} from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { languageNames, storeLocale, supportedLocales, type Locale } from '../../../../packages/i18n/src/index';

export type AutoLockMinutes = 1 | 5 | 15 | 0;

interface SettingsViewProps {
  autoLockMinutes: AutoLockMinutes;
  onAutoLockChange: (minutes: AutoLockMinutes) => void;
  itemCount: number;
  onExportEncrypted: () => void;
  onExportPlaintext: () => void;
  /**
   * Plaintext export is DESKTOP-ONLY. The web client renders this same
   * SettingsView through the shared desktop App, so it must pass false
   * here — otherwise the banner's "encrypted-only" claim would be a lie
   * (see H2: the plaintext button used to be reachable on web).
   * Defaults to true for the desktop app.
   */
  allowPlaintextExport?: boolean;
  onImport: () => void;
  /** CSV import (1Password / Bitwarden). Optional: hidden when absent. */
  existingItems?: VaultItem[];
  onImportCsv?: (items: VaultItem[]) => Promise<void> | void;
  onChangePassphrase: (oldPassphrase: string, newPassphrase: string) => Promise<void>;
  onWipeVault: () => void;
  /**
   * Account server base URL ('' = local-only). The App persists it to
   * localStorage 'my-secrect:api-base-url' and builds the
   * SecurityApiClient from it. The server never sees vault content —
   * only ciphertext and opaque ids.
   */
  apiBaseUrl: string;
  onApiBaseUrlChange: (url: string) => void;
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Section plate with a printed legend heading and an icon. */
function Section({ id, icon, title, tone, children }: { id: string; icon: IconName; title: string; tone?: 'danger'; children: React.ReactNode }) {
  return (
    <Card as="section" padding="lg" aria-labelledby={id} className={tone === 'danger' ? 'ms-card--danger' : undefined}>
      <div className="ms-plate__head">
        <Icon name={icon} className={tone === 'danger' ? 'text-[var(--ms-color-danger-soft-text)]' : 'ms-text-muted'} />
        <h3 id={id} className="ms-heading ms-heading--md">{title}</h3>
      </div>
      {children}
    </Card>
  );
}

export default function SettingsView({
  autoLockMinutes,
  onAutoLockChange,
  itemCount,
  onExportEncrypted,
  onExportPlaintext,
  allowPlaintextExport = true,
  onImport,
  existingItems,
  onImportCsv,
  onChangePassphrase,
  onWipeVault,
  apiBaseUrl,
  onApiBaseUrlChange,
}: SettingsViewProps) {
  const { dict, tp, locale, setLocale } = useTranslation();
  const st = dict.settings;
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPassConfirm, setNewPassConfirm] = useState('');
  const [passMessage, setPassMessage] = useState('');
  const [passError, setPassError] = useState('');
  const [changing, setChanging] = useState(false);
  const [plaintextAck, setPlaintextAck] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [wipeArmed, setWipeArmed] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredTheme() ?? DEFAULT_THEME_MODE);

  const handleChangePassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassError('');
    setPassMessage('');
    if (newPass.length < 8) {
      setPassError(st.tooShort);
      return;
    }
    if (newPass !== newPassConfirm) {
      setPassError(st.mismatch);
      return;
    }
    if (newPass === oldPass) {
      setPassError(st.same);
      return;
    }
    setChanging(true);
    try {
      await onChangePassphrase(oldPass, newPass);
      setPassMessage(st.changed);
      setOldPass('');
      setNewPass('');
      setNewPassConfirm('');
    } catch (err) {
      setPassError(err instanceof Error ? err.message : st.changeFailed);
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className="ms-view ms-view--narrow grid gap-4">
      <div>
        <h2 className="ms-heading ms-heading--lg">{st.title}</h2>
        <p className="ms-text-sm ms-text-muted mb-0 mt-1">{tp(st.summary, itemCount)}</p>
      </div>

      <FamilyView apiBaseUrl={apiBaseUrl} />

      {/* Preferences: language + finish (UI preferences, stored on this device only). */}
      <Section id="settings-preferences-heading" icon="language" title={st.preferencesTitle}>
        <div className="grid gap-5">
          <div className="grid gap-2">
            <span className="ms-label">{dict.language.label}</span>
            <SegmentedControl<Locale>
              ariaLabel={dict.language.label}
              value={locale}
              options={supportedLocales.map((l) => ({ value: l, label: languageNames[l] }))}
              onChange={(next) => {
                storeLocale(next);
                setLocale(next);
              }}
            />
            <p className="ms-field__hint m-0">{dict.language.description}</p>
          </div>
          <div className="grid gap-2">
            <span className="ms-label">{dict.theme.label}</span>
            <SegmentedControl<ThemeMode>
              ariaLabel={dict.theme.label}
              value={themeMode}
              options={[
                { value: 'light', label: dict.theme.light },
                { value: 'dark', label: dict.theme.dark },
                { value: 'system', label: dict.theme.system },
              ]}
              onChange={(next) => {
                setThemeMode(next);
                applyTheme(next);
              }}
            />
            <p className="ms-field__hint m-0">{dict.theme.description}</p>
          </div>
        </div>
      </Section>

      {/* Change master passphrase */}
      <Section id="settings-passphrase-heading" icon="lock" title={st.passphraseTitle}>
        <p className="ms-text-sm ms-text-muted mt-0 ms-prose">{st.passphraseBody}</p>
        <form className="mt-4" onSubmit={(e) => void handleChangePassphrase(e)}>
          <Field id="settings-current-passphrase" label={st.current}>
            <SecureField
              name="current-passphrase"
              value={oldPass}
              onChange={(e) => setOldPass(e.target.value)}
              placeholder={st.currentPlaceholder}
              autoComplete="current-password"
              aria-label={st.current}
            />
          </Field>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field id="settings-new-passphrase" label={st.newPassphrase}>
              <SecureField
                name="new-passphrase"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                placeholder={st.newPlaceholder}
                autoComplete="new-password"
                aria-label={st.newPassphrase}
              />
            </Field>
            <Field id="settings-confirm-new-passphrase" label={st.confirm}>
              <SecureField
                name="confirm-new-passphrase"
                value={newPassConfirm}
                onChange={(e) => setNewPassConfirm(e.target.value)}
                placeholder={st.confirmPlaceholder}
                autoComplete="new-password"
                aria-label={st.confirm}
              />
            </Field>
          </div>
          {passError && <Alert tone="danger" announce className="mb-3">{passError}</Alert>}
          {passMessage && <Alert tone="success" announce className="mb-3">{passMessage}</Alert>}
          <Button type="submit" variant="primary" icon="lock" loading={changing} disabled={!oldPass || !newPass}>
            {changing ? st.changing : st.change}
          </Button>
        </form>
      </Section>

      {/* Auto-lock */}
      <Section id="settings-autolock-heading" icon="timer" title={st.autoLockTitle}>
        <p className="ms-text-sm ms-text-muted mt-0">{st.autoLockBody}</p>
        <Field id="settings-auto-lock" label={st.autoLockAfter} flush className="max-w-xs">
          <Select
            name="auto-lock"
            value={autoLockMinutes}
            onChange={(e) => onAutoLockChange(Number(e.target.value) as AutoLockMinutes)}
            aria-label={st.autoLockAfter}
          >
            <option value={1}>{tp(st.minutes, 1)}</option>
            <option value={5}>{tp(st.minutes, 5)}</option>
            <option value={15}>{tp(st.minutes, 15)}</option>
            <option value={0}>{st.never}</option>
          </Select>
        </Field>
      </Section>

      {/* Account server (Security Center) */}
      <Section id="settings-server-heading" icon="server" title={st.serverTitle}>
        <p className="ms-text-sm ms-text-muted mt-0 ms-prose">{st.serverBody}</p>
        <Field id="settings-api-base-url" label={st.apiUrl} flush>
          <Input
            name="api-base-url"
            type="url"
            mono
            value={apiBaseUrl}
            onChange={(e) => onApiBaseUrlChange(e.target.value)}
            placeholder={st.apiUrlPlaceholder}
            autoComplete="off"
            aria-label={st.apiUrlAria}
          />
        </Field>
      </Section>

      {/* Recovery key */}
      <Section id="settings-recovery-heading" icon="recovery" title={st.recoveryTitle}>
        <p className="ms-text-sm ms-text-secondary m-0 ms-prose">{st.recoveryBody}</p>
      </Section>

      {/* Backup */}
      <Section id="settings-backup-heading" icon="export" title={st.backupTitle}>
        <div className="flex flex-wrap gap-2">
          <Button icon="export" onClick={onExportEncrypted}>
            {st.exportEncrypted}
          </Button>
          <Button icon="import" onClick={onImport}>
            {st.importEncrypted}
          </Button>
        </div>
        <p className="ms-text-sm ms-text-muted mb-0 mt-3 ms-prose">{st.backupBody}</p>
        {allowPlaintextExport ? (
          <div className="mt-4 grid gap-3 border-t border-[var(--ms-color-border-default)] pt-4">
            <Alert tone="danger" title={st.plaintextTitle}>
              {st.plaintextBody}
            </Alert>
            <Checkbox
              id="settings-plaintext-ack"
              name="plaintext-export-ack"
              checked={plaintextAck}
              onChange={(e) => setPlaintextAck(e.target.checked)}
              label={st.plaintextAck}
            />
            <div>
              <Button
                variant="danger"
                icon="export"
                disabled={!plaintextAck}
                onClick={() => {
                  onExportPlaintext();
                  setPlaintextAck(false);
                }}
              >
                {st.plaintextExport}
              </Button>
            </div>
          </div>
        ) : (
          <Alert tone="info" title={st.plaintextDisabledTitle} className="mt-4">
            {st.plaintextDisabledBody}
          </Alert>
        )}
        {existingItems && onImportCsv && (
          <div className="mt-4 border-t border-[var(--ms-color-border-default)] pt-4">
            <CsvImport existingItems={existingItems} onImport={onImportCsv} />
          </div>
        )}
      </Section>

      {/* App info */}
      <Section id="settings-about-heading" icon="info" title={st.aboutTitle}>
        <dl className="m-0 grid gap-2 ms-text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="ms-legend self-center">{st.version}</dt>
          <dd className="m-0">{st.versionValue}</dd>
          <dt className="ms-legend self-center">{st.encryption}</dt>
          <dd className="m-0">{st.encryptionValue}</dd>
          <dt className="ms-legend self-center">{st.storage}</dt>
          <dd className="m-0">{st.storageValue}</dd>
          <dt className="ms-legend self-center">{st.audit}</dt>
          <dd className="m-0">{st.auditValue}</dd>
        </dl>
      </Section>

      {/* Danger zone: wipe vault */}
      <Section id="settings-wipe-heading" icon="warning" title={st.wipeTitle} tone="danger">
        <p className="ms-text-sm ms-text-secondary mt-0 ms-prose">{st.wipeBody}</p>
        {!wipeArmed ? (
          <Button variant="danger-outline" icon="trash" onClick={() => setWipeArmed(true)}>
            {st.wipeArm}
          </Button>
        ) : (
          <div className="grid gap-3">
            <Field id="settings-wipe-confirm" label={st.wipeConfirmLabel} flush className="max-w-xs">
              <Input
                name="wipe-confirm"
                type="text"
                mono
                value={wipeText}
                onChange={(e) => setWipeText(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
                aria-label={st.wipeConfirmAria}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" icon="trash" disabled={wipeText.trim() !== 'DELETE'} onClick={onWipeVault}>
                {st.wipe}
              </Button>
              <Button onClick={() => { setWipeArmed(false); setWipeText(''); }}>
                {st.cancel}
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

export { downloadText };

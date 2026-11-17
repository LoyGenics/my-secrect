import DesktopApp from '../../desktop/src/App';
import { Led } from '../../desktop/src/theme';
import { createTranslator, detectLocale } from '../../../packages/i18n/src/index';

// Web mirror of the desktop vault app.
//
// The web client is a SEPARATE attack surface from the desktop app: the
// code served to this browser could be replaced or tampered with, and a
// compromised page can read secrets after unlock. Sensitive features are
// therefore limited here (see the banner below and apps/web/README.md).
// Prefer the desktop app for full use.
//
// Screens are NOT duplicated here: every screen (onboarding, lock, all
// modules, health, settings, search, generator, export/import) comes from
// the shared desktop App, which also owns the responsive layout. The only
// web-specific code is this frame: the warning banner, the app area (a
// fixed-height row, so the app's panes scroll — never the page) and the
// "limited" footer.

export default function App() {
  // The banner sits outside the app's I18nProvider; it reads the same stored
  // language choice at load.
  const { dict } = createTranslator(detectLocale());
  const w = dict.web;
  return (
    <div className="web-shell grid h-dvh grid-rows-[auto_minmax(0,1fr)_auto] bg-[var(--ms-color-bg-base)]">
      <div role="alert" className="ms-banner">
        <p className="ms-banner__head m-0">
          <Led tone="attention" />
          {w.banner}
        </p>
        <details>
          <summary className="ms-text-sm">{w.why}</summary>
          <ul>
            <li>{w.reasonCompromised}</li>
            <li>{w.reasonAutofill}</li>
            <li>{w.reasonUpload}</li>
            <li>{w.reasonExport}</li>
            <li>{w.reasonNarrow}</li>
          </ul>
        </details>
      </div>
      <div className="min-h-0">
        {/* H2 fix: the web client promises encrypted-only export in the
            banner above. The shared desktop App gates plaintext export
            behind this prop, so passing false here is what makes the
            promise true — Settings hides the plaintext section and the
            export handler refuses it as a second line of defence. */}
        <DesktopApp allowPlaintextExport={false} />
      </div>
      <footer className="ms-footer">{w.footer}</footer>
    </div>
  );
}

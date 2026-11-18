import DesktopApp from '../../desktop/src/App';

// Web mirror of the desktop vault app.
//
// Screens are NOT duplicated here: every screen (onboarding, lock, all
// modules, health, settings, search, generator, export/import) comes from
// the shared desktop App, which also owns the responsive layout. The only
// web-specific code is this frame: a fixed-height app area, so the app's
// panes scroll — never the page.

export default function App() {
  return (
    <div className="web-shell h-dvh bg-[var(--ms-color-bg-base)]">
      <div className="h-full min-h-0">
        {/* Web must never offer plaintext export: the shared desktop App gates
            it behind this prop, so Settings hides the plaintext section and
            the export handler refuses it as a second line of defence. */}
        <DesktopApp allowPlaintextExport={false} />
      </div>
    </div>
  );
}

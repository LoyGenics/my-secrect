import DesktopApp from '../../desktop/src/App';

// Web mirror of the desktop vault app.
//
// The web client is a SEPARATE attack surface from the desktop app: the
// code served to this browser could be replaced or tampered with, and a
// compromised page can read secrets after unlock. Sensitive features are
// therefore limited here (see the banner below and apps/web/README.md).
// Prefer the desktop app for full use.
//
// Screens are NOT duplicated here: every screen (onboarding, lock, all 8
// modules, health, settings, search, generator, export/import) comes from
// the shared desktop App. A fix in the desktop UI shows up here too. The
// only web-specific code is this banner, the "limited" footer note, and the
// responsive rules in index.css (.web-shell).

export default function App() {
  return (
    <div className="web-shell flex min-h-screen flex-col bg-[#0B0F14] text-zinc-100">
      <div
        role="alert"
        className="sticky top-0 z-50 border-b border-amber-500/40 bg-amber-500/15 px-4 py-3 text-sm text-amber-200"
      >
        <p className="mx-auto max-w-3xl font-medium">
          Web client — separate attack surface. Web is limited — use Desktop for sensitive data.
        </p>
        <details className="mx-auto max-w-3xl">
          <summary className="cursor-pointer text-xs text-amber-300 underline">Why is the web client limited?</summary>
          <ul className="mt-1 list-disc pl-5 text-xs text-amber-200/90">
            <li>If the code served to this browser is compromised, secrets can be read after unlock.</li>
            <li>No browser autofill — this client never fills credentials into other sites or forms.</li>
            <li>No file/media upload — attachments cannot be added from the browser.</li>
            <li>Export is encrypted-only — vault data leaves the browser only in encrypted form; there is no plaintext export here.</li>
            <li>Best on a wide screen. On narrow screens the sidebar stacks above the item list.</li>
          </ul>
        </details>
      </div>
      <div className="min-h-0 flex-1">
        {/* H2 fix: the web client promises encrypted-only export in the
            banner above. The shared desktop App gates plaintext export
            behind this prop, so passing false here is what makes the
            promise true — Settings hides the plaintext section and the
            export handler refuses it as a second line of defence. */}
        <DesktopApp allowPlaintextExport={false} />
      </div>
      <footer className="border-t border-zinc-800 px-4 py-2 text-center text-xs text-zinc-500">
        my-secrect web — local-first, encrypted on this device. Not audited, not production-ready. For sensitive data, use the desktop app.
      </footer>
    </div>
  );
}

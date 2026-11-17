// UI driver for tests/e2e_app.rs. Evaluated in the REAL app page after each
// page load; `window.__MY_SECRECT_E2E__ = { phase, passphrase, seed }` is
// prepended by the harness. Reports once by setting document.title to
// `E2E-RESULT <json>` (the harness listens for title changes). It only uses
// the UI and the two IPC commands the capability grants to the page.
(async () => {
  const cfg = window.__MY_SECRECT_E2E__;
  const ROWS = 'my-secrect.local-vault.v1';
  const VAULT_KEYS = [ROWS, 'my-secrect.local-vault.v1.keys'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  // document.title is truncated by WebKit (~1 KB): report short fields only;
  // the harness reads bulk data straight from the store.
  const report = (result) => {
    document.title = 'E2E-RESULT ' + JSON.stringify({ phase: cfg.phase, ...result });
  };
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args ?? {});
  const alertText = () => $('[role="alert"]')?.textContent ?? null;
  const lsVaultKeys = () => VAULT_KEYS.filter((k) => localStorage.getItem(k) !== null);

  async function waitFor(fn, what, ms = 30000) {
    const t0 = Date.now();
    for (;;) {
      const alert = alertText();
      if (alert) throw new Error('storage alert shown: ' + alert);
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
      await sleep(50);
    }
  }

  function type(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function stored() {
    const s = await invoke('kv_snapshot');
    const rows = s.entries[ROWS];
    return {
      generation: s.generation,
      keys: Object.keys(s.entries).sort(),
      ids: rows ? JSON.parse(rows).map((r) => r.id).sort() : [],
      entries: s.entries,
    };
  }

  async function rejected(cmd) {
    try {
      await invoke(cmd);
      return null;
    } catch (e) {
      return String(e);
    }
  }

  async function unlock(passphrase) {
    const form = $('#lock-passphrase').form;
    type($('#lock-passphrase'), passphrase);
    await sleep(150); // let React commit the controlled-input state first
    form.requestSubmit();
  }

  try {
    if (!cfg) throw new Error('driver config missing');
    switch (cfg.phase) {
      case 'create': {
        const start = await stored();
        if (start.generation !== 0 || start.keys.length) throw new Error('store not empty at start');
        if (lsVaultKeys().length) throw new Error('localStorage already holds vault keys');
        await waitFor(() => $('#new-pass'), 'onboarding screen');
        type($('#new-pass'), cfg.passphrase);
        type($('#new-pass-confirm'), cfg.passphrase);
        await sleep(150);
        button('Create vault').click();
        await waitFor(() => $('input[type="checkbox"]'), 'recovery-key step', 90000);
        // Regression guard: with WebAssembly blocked by the CSP, libsodium fell
        // back to asm.js and returned stale heap bytes — the "random" recovery
        // key was the passphrase itself and nothing decrypted after a restart.
        const recoveryKey = $('div.break-all.font-mono')?.textContent ?? '';
        const passphraseB64Url = btoa(cfg.passphrase).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (!recoveryKey || recoveryKey === passphraseB64Url) throw new Error('recovery key is not random');
        $('input[type="checkbox"]').click();
        await waitFor(() => button('Done') && !button('Done').disabled, 'Done button enabled');
        button('Done').click();
        (await waitFor(() => button('Open vault'), 'onboarding done step')).click();
        (await waitFor(() => button('Load example data'), 'empty vault view')).click();
        await waitFor(() => document.body.innerText.includes('Example Secure Note'), 'example items listed');
        // Wait until the write-behind batches reached SQLCipher.
        const s = await waitFor(async () => {
          const st = await stored();
          return st.ids.length >= 12 && st.keys.length === 2 ? st : null;
        }, 'rows committed to the encrypted store');
        report({
          ok: true,
          storedIds: s.ids,
          storedKeys: s.keys,
          generation: s.generation,
          localStorageVaultKeys: lsVaultKeys(),
          denied: {
            coreAppVersion: await rejected('plugin:app|version'),
            coreWindowTitle: await rejected('plugin:window|title'),
            removedCommand: await rejected('vault_database_path'),
          },
        });
        break;
      }
      case 'unlock': {
        await waitFor(() => $('#lock-passphrase') || $('#new-pass'), 'first screen');
        if ($('#new-pass')) throw new Error('onboarding shown after restart: the vault was not found');
        const before = await stored();
        await unlock('definitely the wrong passphrase');
        await waitFor(() => document.body.innerText.includes('Wrong passphrase'), 'wrong-passphrase error');
        await unlock(cfg.passphrase);
        await waitFor(() => document.body.innerText.includes('Example Secure Note'), 'items after unlock');
        report({
          ok: true,
          storedIds: before.ids,
          generation: before.generation,
          localStorageVaultKeys: lsVaultKeys(),
          uiShowsExampleItems: ['Example Website', 'Example Visa', 'Example Secure Note'].every((t) =>
            document.body.innerText.includes(t),
          ),
        });
        break;
      }
      case 'seed-legacy': {
        if (!sessionStorage.getItem('e2e-seeded')) {
          const start = await stored();
          if (start.generation !== 0 || start.keys.length) throw new Error('store not empty at start');
          for (const [k, v] of Object.entries(cfg.seed)) localStorage.setItem(k, v);
          sessionStorage.setItem('e2e-seeded', '1');
          location.reload(); // the app restarts its JS and migrates on load
          return;
        }
        sessionStorage.removeItem('e2e-seeded');
        await waitFor(() => $('#lock-passphrase') || $('#new-pass'), 'first screen after reload');
        const lockScreen = !!$('#lock-passphrase');
        await waitFor(() => lsVaultKeys().length === 0, 'localStorage vault keys removed after migration');
        const s = await stored();
        report({
          ok: true,
          lockScreenOnFirstRender: lockScreen,
          migratedVerbatim: Object.entries(cfg.seed).every(([k, v]) => s.entries[k] === v),
          storedIds: s.ids,
          generation: s.generation,
          localStorageVaultKeys: lsVaultKeys(),
        });
        break;
      }
      case 'expect-alert': {
        // The store must refuse to open; the page shows the alert and the
        // vault UI never mounts.
        const t0 = Date.now();
        while (!alertText() && Date.now() - t0 < 30000) await sleep(50);
        report({
          ok: true,
          alert: (alertText() ?? '').slice(0, 400),
          vaultUiMounted: !!($('#new-pass') || $('#lock-passphrase')),
          localStorageVaultKeys: lsVaultKeys(),
        });
        break;
      }
      default:
        throw new Error('unknown phase ' + cfg.phase);
    }
  } catch (e) {
    report({ ok: false, error: String(e), screen: document.body.innerText.slice(0, 300) });
  }
})();

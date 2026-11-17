/**
 * Content script — injected ON DEMAND by the background (chrome.scripting)
 * into the active tab only, for a single user-chosen fill. There is NO
 * persistent content script and NO broad host permission in the manifest.
 *
 * It receives exactly ONE username + ONE password, and only fills them when:
 *  - this is the top-level frame (window.top === window.self) — never an iframe,
 *  - the message origin matches window.location.origin exactly.
 * It never receives the vault, any key, or any other item. It never stores
 * anything. It never sends field VALUES anywhere — form detection reports
 * only that a login form exists (origin + which fields exist).
 */
import type { FillMessage } from '../lib/messages';

declare global {
  interface Window {
    __mySecrectContentLoaded?: boolean;
  }
}

if (!window.__mySecrectContentLoaded) {
  window.__mySecrectContentLoaded = true;

  function setFieldValue(el: HTMLInputElement, value: string): void {
    // Use the native setter so React / framework-controlled inputs notice.
    const proto = Object.getPrototypeOf(el) as HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findUsernameField(): HTMLInputElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    return (
      candidates.find((el) => el.getAttribute('autocomplete') === 'username') ??
      candidates.find((el) => /user(name)?|login|email/i.test(el.name + ' ' + el.id) && el.type !== 'password') ??
      candidates.find((el) => (el.type === 'text' || el.type === 'email') && el.offsetParent !== null) ??
      null
    );
  }

  function findPasswordField(): HTMLInputElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    return candidates.find((el) => el.offsetParent !== null) ?? candidates[0] ?? null;
  }

  chrome.runtime.onMessage.addListener((message: FillMessage, _sender, sendResponse) => {
    if (message.type !== 'ext-fill') return false;
    if (window.top !== window.self) {
      sendResponse({ ok: false, error: 'Refusing to fill inside an iframe.' });
      return false;
    }
    if (message.origin !== window.location.origin) {
      sendResponse({ ok: false, error: 'Fill origin does not match this page.' });
      return false;
    }
    const usernameField = findUsernameField();
    const passwordField = findPasswordField();
    if (!passwordField) {
      sendResponse({ ok: false, error: 'No password field found on this page.' });
      return false;
    }
    if (usernameField) setFieldValue(usernameField, message.username);
    setFieldValue(passwordField, message.password);
    sendResponse({ ok: true, filled: true });
    return false;
  });

  // Login-form detection (values NEVER leave the page): report once per load
  // that a form with username/password fields exists, so the popup can offer
  // to save a login for this site. The user still types the credentials.
  function detectLoginForm(): void {
    const hasPassword = document.querySelector('input[type="password"]') !== null;
    if (!hasPassword) return;
    const hasUsername =
      document.querySelector('input[autocomplete="username"]') !== null ||
      Array.from(document.querySelectorAll('input')).some((el) => /user(name)?|login|email/i.test(el.name + ' ' + el.id));
    chrome.runtime
      .sendMessage({ type: 'ext-form-detected', origin: window.location.origin, hasUsername, hasPassword })
      .catch(() => undefined);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', detectLoginForm, { once: true });
  } else {
    detectLoginForm();
  }
}

/**
 * Content script — injected ON DEMAND by the background (chrome.scripting)
 * into the active tab only, for a single user-chosen fill. There is NO
 * persistent content script and NO broad host permission in the manifest.
 *
 * It receives exactly ONE username + ONE password, and only fills them when:
 *  - this is the top-level frame (window.top === window.self) — never an iframe,
 *  - the message origin matches window.location.origin exactly,
 *  - into a visible, editable login password field and the username field of
 *    the SAME form, placed before it — never hidden/honeypot fields, never a
 *    sign-up (new-password) field, never another form on the page.
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

  const USERNAME_TYPES = new Set(['text', 'email', 'tel']);
  const MIN_FIELD_PX = 8;

  function hasAutocomplete(el: HTMLInputElement, token: string): boolean {
    return (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).includes(token);
  }

  /**
   * A field the user can see and type into. Honeypots hide fields with
   * display/visibility/opacity (on the field or an ancestor), a tiny box, or
   * off-page positioning; none of them may receive a credential.
   */
  function isUsable(el: HTMLInputElement): boolean {
    if (el.disabled || el.readOnly || !el.isConnected) return false;
    if (typeof el.checkVisibility !== 'function') return false; // fail closed on old engines
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_FIELD_PX || rect.height < MIN_FIELD_PX) return false;
    const left = rect.left + window.scrollX;
    const top = rect.top + window.scrollY;
    const root = document.documentElement;
    return left + rect.width > 0 && top + rect.height > 0 && left < root.scrollWidth && top < root.scrollHeight;
  }

  /** A visible login password field; a page with only new-password fields gets nothing. */
  function findPasswordField(): HTMLInputElement | null {
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(isUsable);
    return (
      fields.find((el) => hasAutocomplete(el, 'current-password')) ??
      fields.find((el) => !hasAutocomplete(el, 'new-password')) ??
      null
    );
  }

  /** The username of the SAME form as the password (or both form-less), before it, visible. */
  function findUsernameField(password: HTMLInputElement): HTMLInputElement | null {
    const nearestFirst = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
      .filter(
        (el) =>
          USERNAME_TYPES.has(el.type) &&
          el.form === password.form &&
          (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          isUsable(el),
      )
      .reverse();
    return (
      nearestFirst.find((el) => hasAutocomplete(el, 'username')) ??
      nearestFirst.find((el) => hasAutocomplete(el, 'email') || /user|login|email/i.test(`${el.name} ${el.id}`)) ??
      nearestFirst[0] ??
      null
    );
  }

  chrome.runtime.onMessage.addListener((message: FillMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'ext-fill') return false;
    if (window.top !== window.self) {
      sendResponse({ ok: false, error: 'Refusing to fill inside an iframe.' });
      return false;
    }
    if (message.origin !== window.location.origin) {
      sendResponse({ ok: false, error: 'Fill origin does not match this page.' });
      return false;
    }
    // Only this document's own fields: querySelectorAll never reaches into
    // iframes, and this script is injected into frame 0 only.
    const passwordField = findPasswordField();
    if (!passwordField) {
      sendResponse({ ok: false, error: 'No visible password field to fill on this page.' });
      return false;
    }
    const usernameField = findUsernameField(passwordField);
    if (usernameField && message.username) setFieldValue(usernameField, message.username);
    setFieldValue(passwordField, message.password);
    sendResponse({ ok: true, filled: true });
    return false;
  });

  // Login-form detection (values NEVER leave the page): report once per load
  // that a form with username/password fields exists, so the popup can offer
  // to save a login for this site. The user still types the credentials.
  function detectLoginForm(): void {
    const password = findPasswordField();
    if (!password) return;
    const hasUsername = findUsernameField(password) !== null;
    // No origin in the message: the background takes it from the browser.
    chrome.runtime.sendMessage({ type: 'ext-form-detected', hasUsername, hasPassword: true }).catch(() => undefined);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', detectLoginForm, { once: true });
  } else {
    detectLoginForm();
  }
}

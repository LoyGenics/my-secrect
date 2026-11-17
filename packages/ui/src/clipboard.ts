/**
 * Copy with automatic clipboard clearing (web/desktop).
 *
 * The UI promises "COPIED · CLEARS IN 30S", so this module keeps that
 * promise even when the copying component unmounts (vault locks, view
 * changes): the timer is module-level, not component state. At the
 * deadline it reads the clipboard when the browser allows it and clears
 * only if our value is still there; when reading is not permitted it
 * clears anyway (the same trade-off password managers make). If the write
 * is refused because the window is not focused, it retries once on the
 * next focus.
 */
import { useEffect, useState } from 'react';

export const CLIPBOARD_CLEAR_MS = 30_000;

interface ActiveCopy {
  key: string;
  value: string;
  clearsAt: number;
}

let active: ActiveCopy | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(copy: ActiveCopy | null) => void>();

function emit() {
  for (const listener of listeners) listener(active);
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

async function clearIfStillOurs(value: string): Promise<void> {
  let current: string | null = null;
  try {
    current = await navigator.clipboard.readText();
  } catch {
    current = null; // reading not permitted: clear anyway
  }
  if (current !== null && current !== value) return; // user copied something else since
  const cleared = await writeClipboard('');
  if (!cleared && typeof window !== 'undefined') {
    window.addEventListener('focus', () => void writeClipboard(''), { once: true });
  }
}

/** Copy `value`, remember it under `key` for the UI, and schedule the clear. */
export async function copyWithClear(key: string, value: string, clearAfterMs = CLIPBOARD_CLEAR_MS): Promise<boolean> {
  const ok = await writeClipboard(value);
  if (!ok) return false;
  if (timer) clearTimeout(timer);
  active = { key, value, clearsAt: Date.now() + clearAfterMs };
  emit();
  timer = setTimeout(() => {
    const copied = active;
    active = null;
    timer = null;
    emit();
    if (copied) void clearIfStillOurs(copied.value);
  }, clearAfterMs);
  return true;
}

/**
 * Subscribe to the active copy. Returns the key that was copied last (or
 * null) and the whole seconds until the clipboard clears, ticking once a
 * second while something is pending.
 */
export function useClipboardStatus(): { copiedKey: string | null; secondsLeft: number } {
  const [copy, setCopy] = useState<ActiveCopy | null>(active);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    listeners.add(setCopy);
    return () => {
      listeners.delete(setCopy);
    };
  }, []);
  useEffect(() => {
    if (!copy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [copy]);
  if (!copy) return { copiedKey: null, secondsLeft: 0 };
  return { copiedKey: copy.key, secondsLeft: Math.max(0, Math.ceil((copy.clearsAt - now) / 1000)) };
}

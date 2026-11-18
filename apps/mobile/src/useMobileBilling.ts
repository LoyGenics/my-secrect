import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { BillingApiClient, type MobileBillingState } from '../../../packages/sdk/src/billing';
import { isUnauthorized } from '../../../packages/sdk/src/security';
import { getApiToken } from './screens/SecurityScreen';

export function useMobileBilling(baseUrl: string, session: number | null, onUnauthorized: () => void) {
  const source = useMemo(() => session === null ? undefined : {
    api: new BillingApiClient({ baseUrl, getToken: getApiToken }),
    controller: new AbortController(),
    queue: Promise.resolve(),
    checking: undefined as Promise<MobileBillingState> | undefined,
  }, [baseUrl, session]);
  const [result, setResult] = useState<{ source: typeof source; access?: MobileBillingState; failed?: boolean }>();
  const [pending, setPending] = useState<{ source: typeof source; user: string }>();

  const request = useCallback((reconcile = false) => {
    if (!source || source.controller.signal.aborted) return Promise.reject(new Error('billing_session_ended'));
    if (!reconcile && source.checking) return source.checking;
    const { signal } = source.controller;
    const work = source.queue.then(async () => {
      if (signal.aborted) throw new Error('billing_session_ended');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, reconcile ? 25_000 : 8_000);
      try {
        const access = await (reconcile ? source.api.refreshStore(controller.signal) : source.api.access(controller.signal));
        if (!access || !['free', 'pro'].includes(access.tier) || !access.app_user_id) throw new Error('invalid_billing_access');
        if (!signal.aborted) {
          setResult({ source, access });
          if (access.tier === 'pro') setPending(current => current?.source === source ? undefined : current);
        }
        return access;
      } catch (error) {
        if (!signal.aborted) {
          if (isUnauthorized(error)) onUnauthorized();
          else if (!reconcile) setResult({ source, failed: true });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    });
    source.queue = work.then(() => { if (source.checking === work) source.checking = undefined; },
      () => { if (source.checking === work) source.checking = undefined; });
    if (!reconcile) source.checking = work;
    return work;
  }, [onUnauthorized, source]);

  useEffect(() => {
    if (!source) return;
    if (source.controller.signal.aborted) {
      source.controller = new AbortController();
      source.checking = undefined;
    }
    const check = () => { void request().catch(() => undefined); };
    check();
    const sub = AppState.addEventListener('change', state => { if (state === 'active') check(); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') check(); }, 60_000);
    return () => { source.controller.abort(); sub.remove(); clearInterval(timer); };
  }, [request, source]);

  const access = source && result?.source === source ? result.access : undefined;
  return {
    access, failed: result?.source === source && result?.failed === true,
    signal: source?.controller.signal,
    pending: Boolean(source && pending?.source === source && (!access || access.app_user_id === pending.user) && access?.tier !== 'pro'),
    markPending: (user: string) => setPending({ source, user }),
    request,
  };
}

export type MobileBilling = ReturnType<typeof useMobileBilling>;

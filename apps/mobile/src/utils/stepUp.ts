/**
 * Step-up helpers, shared by SecurityScreen and SettingsScreen.
 *
 * The window and the step-up-required decision are canonical in the SDK
 * (packages/sdk/src/security.ts): STEP_UP_WINDOW_MS is 10 minutes and
 * isStepUpFresh uses `<=`, i.e. a verification is still fresh at exactly
 * 10 minutes. This module re-exports them so mobile agrees with desktop,
 * and adds the small error-shape helpers the SDK does not provide
 * (apiStatus, isNetworkError).
 *
 * 403 handling: the backend answers a missing/expired step-up with
 * 403 {error: 'step_up_required'}. That response must RE-PROMPT, never
 * proceed — isStepUpRequired() is the single place that decides.
 * The mirror test (apps/mobile/tests/security-step-up.test.mjs) copies
 * this logic in plain Node; if the SDK changes, update that mirror.
 */
import { isUnauthorized } from '../../../../packages/sdk/src/security';

export { STEP_UP_WINDOW_MS, isStepUpFresh, isStepUpRequired } from '../../../../packages/sdk/src/security';

/** A wrong step-up code can also return 401 without invalidating the session. */
export function isSessionUnauthorized(error: unknown): boolean {
  return isUnauthorized(error) && error instanceof Error && !error.message.includes('verification_failed');
}

/** HTTP status of an SDK error, or null when the request never got one (offline / programming error). */
export function apiStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  return null;
}

/** True when the request failed before any HTTP status existed — i.e. the device is offline. */
export function isNetworkError(err: unknown): boolean {
  if (apiStatus(err) !== null) return false;
  if (err instanceof Error) return err.name === 'TypeError' || /network request failed|failed to fetch|networkerror/i.test(err.message);
  return false;
}

/**
 * Account sign-in gate state (pure, testable). The gate shows when a
 * server is configured, there is no valid session and the user has not
 * chosen "Continue without signing in" for this session.
 */
export interface AuthGateState {
  signedIn: boolean;
  /** The user chose local-only for this session. */
  localOnlyBypass: boolean;
  sessionExpired: boolean;
}

export function shouldShowSignInGate(hasServer: boolean, state: AuthGateState): boolean {
  return hasServer && !state.signedIn && !state.localOnlyBypass;
}

/**
 * A server call answered 401: the stored session is gone, so the user is
 * signed out and, if they had signed in, sees the gate with a
 * "session expired" note. A user who chose local-only keeps that choice
 * for the session — without a session, 401s from account screens are
 * expected, and resetting the choice bounced "Continue without signing in"
 * straight back to the gate until reload (QA DEFECT-H4).
 */
export function afterUnauthorized(state: AuthGateState): AuthGateState {
  if (state.localOnlyBypass) return { signedIn: false, localOnlyBypass: true, sessionExpired: false };
  return { signedIn: false, localOnlyBypass: false, sessionExpired: true };
}

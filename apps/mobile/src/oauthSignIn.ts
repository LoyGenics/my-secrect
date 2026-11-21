import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { AuthRequest, ResponseType, exchangeCodeAsync } from 'expo-auth-session';
import { GOOGLE_DISCOVERY, appleFullName, appleNonce, googleRedirectUri } from './utils/oauth';

export interface IdpCredential { idToken: string; fullName?: string }

/**
 * Google: authorization code + PKCE in the system browser, with the raw nonce,
 * exchanged on the device (installed-app client, no secret) for the ID token.
 * Resolves null when the user closes the browser.
 */
export async function googleCredential(clientId: string, nonce: string): Promise<IdpCredential | null> {
  const redirectUri = googleRedirectUri(Platform.OS, clientId);
  const request = new AuthRequest({
    clientId,
    redirectUri,
    scopes: ['openid', 'email', 'profile'],
    responseType: ResponseType.Code,
    usePKCE: true,
    extraParams: { nonce },
  });
  const result = await request.promptAsync(GOOGLE_DISCOVERY);
  if (result.type === 'cancel' || result.type === 'dismiss') return null;
  if (result.type !== 'success' || !request.codeVerifier) throw new Error('google sign-in did not complete');
  const tokens = await exchangeCodeAsync({
    clientId,
    redirectUri,
    code: result.params.code,
    extraParams: { code_verifier: request.codeVerifier },
  }, GOOGLE_DISCOVERY);
  if (!tokens.idToken) throw new Error('google returned no id token');
  return { idToken: tokens.idToken };
}

/** Sign in with Apple (iOS). Resolves null when the user cancels the sheet. */
export async function appleCredential(rawNonce: string): Promise<IdpCredential | null> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: appleNonce(rawNonce),
    });
    if (!credential.identityToken) throw new Error('apple returned no identity token');
    return { idToken: credential.identityToken, fullName: appleFullName(credential.fullName) };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ERR_REQUEST_CANCELED') return null;
    throw error;
  }
}

export function appleSignInAvailable(): Promise<boolean> {
  return Platform.OS === 'ios' ? AppleAuthentication.isAvailableAsync().catch(() => false) : Promise.resolve(false);
}

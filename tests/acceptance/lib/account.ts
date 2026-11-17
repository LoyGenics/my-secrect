/**
 * Node-side account operations through the REAL SDK (SecurityApiClient) and
 * real WebAuthn ceremonies (SoftwareAuthenticator from tests/sync-e2e,
 * verified by the API's webauthn gem). Used to set up server state that a
 * user would create in the Security Center, and to act as "device A".
 */
import { SecurityApiClient } from '../../../packages/sdk/src/security.ts';
import { SoftwareAuthenticator } from '../../sync-e2e/software-authenticator.ts';

export class AccountSession {
  token: string;
  constructor(readonly apiBase: string, readonly email: string, token: string) { this.token = token; }

  client(): SecurityApiClient {
    return new SecurityApiClient({ baseUrl: this.apiBase, getToken: async () => this.token });
  }

  static async signIn(apiBase: string, email: string, auth: SoftwareAuthenticator): Promise<AccountSession> {
    const sec = new SecurityApiClient({ baseUrl: apiBase, getToken: async () => null });
    const opts: any = await sec.passkeyAuthenticateOptions(email);
    const res: any = await sec.passkeyLoginVerify(email, auth.get(opts.request_options.challenge));
    if (!res.token) throw new Error('sign-in yielded no session');
    return new AccountSession(apiBase, email, res.token);
  }

  async stepUp(auth: SoftwareAuthenticator): Promise<void> {
    const c = this.client();
    const opts: any = await c.stepUpPasskeyOptions();
    await c.stepUpPasskey(auth.get(opts.request_options.challenge));
  }

  /** Real add-passkey flow (step-up first). Adopts the rotated session token. */
  async addPasskey(stepUpWith: SoftwareAuthenticator, newPasskey: SoftwareAuthenticator): Promise<void> {
    await this.stepUp(stepUpWith);
    const c = this.client();
    const opts: any = await c.passkeyAddOptions();
    const res = await c.passkeyAddVerify(newPasskey.create(opts.creation_options.challenge));
    if (res?.rotated_token) this.token = res.rotated_token;
  }
}

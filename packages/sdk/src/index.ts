/** TypeScript API client for the Rails API. Sends ONLY ciphertext + opaque ids. */
export interface ApiClientConfig { baseUrl: string; getToken: () => Promise<string | null>; }
export class VaultApiClient {
  constructor(private cfg: ApiClientConfig) {}
  private async req(path: string, init: RequestInit = {}) {
    const token = await this.cfg.getToken();
    const res = await fetch(this.cfg.baseUrl + path, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`API ${res.status} ${path}`);
    return res.json();
  }
  listVaults() { return this.req('/v1/vaults'); }
  getItem(vaultId: string, itemId: string) { return this.req(`/v1/vaults/${vaultId}/items/${itemId}`); }
  putItem(vaultId: string, itemId: string, body: unknown) { return this.req(`/v1/vaults/${vaultId}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(body) }); }
  syncPull(vaultId: string, since?: string) { return this.req(`/v1/vaults/${vaultId}/sync${since ? `?since=${since}` : ''}`); }
  syncPush(vaultId: string, body: unknown) { return this.req(`/v1/vaults/${vaultId}/sync/push`, { method: 'POST', body: JSON.stringify(body) }); }
}

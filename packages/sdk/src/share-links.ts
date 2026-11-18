import { ApiError, type ApiClientConfig } from './index';
import type { ShareLinkRecord } from '../../core/src/share-link';
export interface OwnedShareLink extends ShareLinkRecord { encrypted_owner_metadata: string; revoked_at: string | null; created_at: string }
export class ShareLinksApiClient {
  constructor(private readonly config: ApiClientConfig) {}
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const token = await this.config.getToken();
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/share-links${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) { let detail: unknown; try { detail = await response.json(); } catch {} throw new ApiError(response.status, '/v1/share-links', detail); }
    return response.status === 204 ? undefined as T : response.json();
  }
  list(): Promise<{ links: OwnedShareLink[] }> { return this.request(''); }
  create(record: ShareLinkRecord, encryptedOwnerMetadata: string): Promise<{ link: OwnedShareLink }> { return this.request('', 'POST', { ...record, encrypted_owner_metadata: encryptedOwnerMetadata }); }
  revoke(id: string): Promise<void> { return this.request(`/${encodeURIComponent(id)}`, 'DELETE'); }
}

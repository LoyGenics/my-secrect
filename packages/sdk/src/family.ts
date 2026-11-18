import { ApiError, type ApiClientConfig } from './index';

export interface FamilyMember { id: string; user_id: string; email: string; status: 'pending' | 'active'; role: 'owner' | 'member' }
export interface FamilyState {
  current_user_id: string;
  family: { id: string; owner_id: string; role: 'owner' | 'member'; seats: number; members: FamilyMember[] } | null;
  invitation: { id: string; owner_email: string; expires_at: string } | null;
}

/** Account grouping only. No vault data or keys are sent or received. */
export class FamilyApiClient {
  constructor(private readonly config: ApiClientConfig) {}
  private async request(path = '', method = 'GET', body?: unknown): Promise<FamilyState> {
    const token = await this.config.getToken();
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/family${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, '/v1/family', result);
    return result as FamilyState;
  }
  get(): Promise<FamilyState> { return this.request(); }
  create(): Promise<FamilyState> { return this.request('', 'POST'); }
  invite(email: string): Promise<FamilyState> { return this.request('/invitations', 'POST', { email }); }
  accept(id: string): Promise<FamilyState> { return this.request(`/invitations/${encodeURIComponent(id)}/accept`, 'POST'); }
  remove(id: string): Promise<FamilyState> { return this.request(`/members/${encodeURIComponent(id)}`, 'DELETE'); }
  dissolve(): Promise<FamilyState> { return this.request('', 'DELETE'); }
}

export function familyErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'family.signedOut';
  const message = error instanceof Error ? error.message : '';
  if (message.includes('family_full')) return 'family.full';
  if (message.includes('already_in_family')) return 'family.already';
  if (message.includes('recipient_unavailable')) return 'family.missing';
  if (message.includes('invitation_expired')) return 'family.expired';
  return 'family.error';
}

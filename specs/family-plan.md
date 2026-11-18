# Family accounts v1

A family contains one owner and up to five other registered accounts. Each account keeps
its existing personal vault, passphrase, recovery key and independent encryption keys.
Membership never grants access to vaults, records or keys. Item sharing continues to use
`sharing-protocol.md`, with explicit recipient fingerprint verification and consent.

Family is free during early access. There is no billing integration or automatic paid
entitlement. Paid family prices have not been decided. Quotas continue to apply per user.

## API

Authenticated routes, under `/api/v1`:

- `GET /family`: current family and roster, or one's own pending invitation, or neither.
- `POST /family`: create a family and its active owner membership.
- `POST /family/invitations` `{ email }`: owner invites an active existing account.
- `POST /family/invitations/:id/accept`: only the invited account can accept.
- `DELETE /family/members/:id`: owner removes a member or invitation; a member leaves
  or declines. The owner cannot remove their own membership.
- `DELETE /family`: owner dissolves the family. All private vaults remain intact.

All writes require a fresh account step-up. Pending invitations expire after seven days
and reserve a seat until then. An account may belong to one family or pending invitation
at a time. Family capacity changes serialize on the family row; writes that place an
account in a family also lock that account. A unique user membership index enforces the
cross-family constraint. The server stores account ids, roster emails (existing account
metadata), invitation state and timestamps. It stores no additional vault content or keys.

The owner and active members can see the live roster. A pending invitee can see only their
invitation and inviter's email. Outsiders cannot read or mutate another family's records.
Removing membership does not revoke independent item shares: the item owner or recipient
can revoke those in Sharing. Deleting the owner's account dissolves the family; deleting
another member removes their membership. These operations do not delete anyone else's vault.

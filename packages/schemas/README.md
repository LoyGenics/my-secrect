# @my-secrect/schemas — versioned item schemas (v1)

Client-side schemas for vault item plaintext. They validate fields **before
encryption**; the server never sees field names, titles, tags, types, or
relations — only ciphertext + opaque ids.

```ts
import { validateItemSchema, SCHEMA_VERSION } from '../../schemas/src/index';

const problems = validateItemSchema('card', SCHEMA_VERSION, fields);
if (problems.length) throw new Error(problems.join('; '));
```

## Schema versioning + migration rules

- **Every item type is versioned.** Current version is **v1** for all types
  (`SCHEMA_VERSION = 1`, `SUPPORTED_SCHEMA_VERSIONS = [1]`). Every stored
  `VaultItem` carries `schema_version: 1` (`packages/core/src/types.ts`).
- **Additive only within a version.** New fields are added as *optional*.
  Existing fields are **never renamed, removed, or re-typed** in place.
  `ITEM_SCHEMAS` is kept byte-for-byte for backward compatibility; the
  versioned view is `ITEM_SCHEMA_VERSIONS`.
- **Breaking change = new version.** A rename, removal, type change, or a
  field becoming required ships as v2 (new `schema_version`, new entries in
  `ITEM_SCHEMA_VERSIONS`, `SUPPORTED_SCHEMA_VERSIONS = [1, 2]`), with a
  client-side migration that reads v1, converts, and writes v2 — never a
  silent reinterpretation of old data. The server does not migrate item
  plaintext (it cannot decrypt it); migration is a client responsibility.
- **Unknown versions are rejected.** `validateItemSchema` returns an error
  for any `schema_version` outside `SUPPORTED_SCHEMA_VERSIONS`. Older
  clients must refuse items they do not understand, not guess.
- **Unknown fields are allowed** within a supported version (forward
  compatibility for v1.x optional additions). Unknown *types* are rejected.
- **Forbidden fields are never stored, in any version:** card CVV/CVC
  (`cvv`, `cvv2`, `cvc`, `cvc2`), any `pin`, and live one-time codes
  (`otp`, `one_time_code`, `one_time_password`, `totp_code`). A TOTP
  *secret* (`totp_secret`) is storable; a live TOTP *code* is not.
  `validateItemFields` rejects these case-insensitively.
- **Validation runs client-side, pre-encryption.** `validateItemFields(type,
  fields)` returns a list of problems (`[]` = valid): unknown type, missing
  required field, forbidden field present.

## Tests

Mirror tests (plain Node, no TS loader — same convention as `tests/`):

```sh
node --test packages/schemas/tests/
```

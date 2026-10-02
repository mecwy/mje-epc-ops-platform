# Contract register header reader (DG05-1a)

This first contract slice exposes authenticated GET `/api/contracts`, GET
`/api/contracts/:id` and GET `/api/contracts/:id/history`. It consumes immutable
contract identity, revision headers and source locations. Only synthetic TEST
fixtures populate them in this slice; there is no application write or grant
administration endpoint yet.

An active verified membership plus an explicit unexpired, unrevoked contract
view grant is necessary. Grants bind membership, account and Person separately.
Job titles, legacy report roles and information ownership confer no contract
access. A grant's direction applies to every read. Organization amount grants
expose decimal strings and value states; internal correction text additionally
requires organization internal access. Original-source identifiers/locations
require original access. No source download or Blob address is returned.

Project-only grants intentionally return no contracts until version-pinned line
shares and their projection are implemented in DG05-1b. This fails closed and is
not project-scope acceptance. A denied contract and a missing contract have the
same error code/shape. Hidden contracts do not affect the returned ordering or
counts. All three routes use the same field projection. The legacy TEST
interpreter refuses to evaluate these explicit-grant entries; real contract
HTTP/database tests establish their direction/scope behavior.

Migration `202610090001_contract_register` adds five tables, composite tenant
references, read-only app grants, tenant RLS, immutable history, and grant/revoke
authzVersion triggers. Revocation takes the existing account write lock, so it
serializes with the transaction's account share lock. This slice does not expose
contract writes, allocate money, adopt design quantities, change report snapshots,
approve payments, or notify anyone. Future registration/correction commands must
add source completeness, revision sequence, actor/Person, attention, CAS and
idempotency validation before enabling writes; current seed access is confined to
migration/TEST ownership, never the application role.

Validation: `pnpm check`, `pnpm format:check`, `pnpm db:migrate`,
`pnpm test:integration`, `pnpm test:contract-register`. The latter creates its own
local disposable TEST database and non-bypass application login, uses signed
HTTP tokens, checks hidden-state mutation, exact decimal/zero, same-Person
accounts, expiry, revocation serialization, all three projectors, foreign source
binding and immutable history. No private-source regression or real Entra login
is claimed. Integration fixtures are not production contracts.

Roll back the application using a compatible image while retaining all tables,
revisions, grants/revocations, RLS, constraints and migration history. No drop,
reset, or alteration of an applied migration. DG05-1 parent acceptance remains
open for line/share projection, create/correct/attention commands, account-local
drafts, preview and four-language browser journeys.

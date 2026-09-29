# A6 design: field devices, worker check-in and foreman quantities

Status: design for review (AGENTS.md: slices with state machines and timing get a one-page design before code). No application code, migration or contract in this PR. All examples are synthetic TEST data; coordinates are `0.000000, 0.000000`-style placeholders.

Scope: U2.1 rules 1, 9, 11, 12, 13 and 14 (check-in, headcount, time, decimals, permissions), the foreman quantity report and the PM "adopt" step. Out of scope: the offline queue (A8), hours or timesheets, face recognition, payroll, a mini-program or native app, bulk roster import.

## 0. Key decisions

1. A **FieldDevice** is a browser-held secret bound to one Person on one project. It proves possession of a secret that a PM or foreman confirmed for that person. It does not prove identity, presence or who holds the phone.
2. The token is 256 random bits, **generated on the device** (Web Crypto), sent once in the bind body and afterwards only in `Authorization: Bearer fd1.<token>`. The server stores SHA-256 only. The QR code carries a rotatable **project entry code** in the URL fragment, never a token.
3. States: `PENDING → CONFIRMED → REVOKED`, plus `REJECTED` and `EXPIRED`. Terminal states never come back. Rebinding creates a new row. A person has at most one CONFIRMED device per project.
4. **Check-ins from a PENDING device are rejected** (`DEVICE_PENDING`). The foreman confirms on the spot or checks the worker in as a proxy.
5. One non-voided check-in per (project, person, business day). The business day comes from `occurredAt` in the project timezone, never from the server receive time.
6. Self check-in outside 500 m, or with accuracy worse than 100 m, is **rejected** (spec rule 9). The fact can still be recorded through a foreman or PM proxy. A rejection is a request error, not a finding. Accepted check-ins store the location as a claim, with flags.
7. Proxy check-in is allowed only for the crew's foreman on that business day, or a project PM. It records who acted, where they were, and the proxy kind.
8. A check-in counts toward "checked in N (self X / proxy Y)". It never becomes hours and never writes `facts.people` or `facts.presence`.
9. Foreman reports are append-only revisions per crew and day. The PM **adopts** a total explicitly, against the exact revisions they saw. A partial (unknown-containing) total cannot be adopted. The snapshot keeps both the foreman claim and the PM value.
10. Field facts that arrive after the day is submitted are stored and marked `afterSubmission`. The submitted revision never changes (rule 1). Adoption on a locked day needs a correction.

## 1. Actors and identity

| Actor                        | Authenticates with                                                                 | May                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker (Person, no account)  | CONFIRMED FieldDevice                                                              | Own check-in; release own device                                                                                                                             |
| Foreman (Person, no account) | CONFIRMED FieldDevice + FOREMAN row in `CrewAssignment` valid on the business date | Worker actions; proxy check-in and device confirm/reject for own crew; crew quantity report                                                                  |
| Project manager              | Entra `LoginAccount` + `PROJECT_MANAGER` membership                                | Confirm, reject or revoke any device of the project; proxy any rostered person; void a check-in; adopt totals; set the site reference; rotate the entry code |
| Executive reader             | Entra + `EXECUTIVE_READER`                                                         | Reads the submitted snapshot only (OD18); no field endpoints                                                                                                 |

- **Person** is the natural person. **LoginAccount** is an Entra account (optional). **FieldDevice** is a per-project possession credential of a Person. Roles are never stored on the device. Foreman power is recomputed on every request from `CrewAssignment`, so a foreman who is replaced loses proxy rights on the next request.
- **Same person, several devices or accounts.** Check-in uniqueness is per Person, so extra devices cannot add presence. Confirming a new device revokes the person's previous CONFIRMED device in the same transaction (`endReason=REPLACED`). The confirmer's Person must differ from the device's Person (DB CHECK). A PM or foreman cannot confirm their own device through a second account or device.
- **Lost phone:** the PM revokes it (immediate), and the worker binds the new phone. **Cleared browser data:** the token is gone, so the worker rebinds. **Shared phone:** one token means one person. Another person on that phone is checked in by the foreman (U2.1 check-in decision); the attempt is refused, not treated as a violation.
- **Limit, stated plainly:** the server cannot tell that two tokens sit on the same handset. We deliberately do no fingerprinting. Organized proxying cannot be fully prevented. It is handled by per-binding confirmation, flags and human spot checks, never by automatic judgement.

## 2. FieldDevice state machine

```text
          bind (entry code + roster pick)
                    │
                    ▼
   ┌──────────── PENDING ────────────┐
   │ reject (PM/foreman)             │ pendingUntil passed
   ▼                                 ▼
REJECTED     confirm (PM/foreman)  EXPIRED ◀── idle > 30 d, expiresAt, or assignment ended
                    │                  ▲
                    ▼                  │
               CONFIRMED ──────────────┘
                 │   ▲  rotate (same state, new hash, generation+1)
                 └───┘
                    │ revoke (PM) · release (self) · replaced by a newer confirm
                    ▼
                 REVOKED
```

| Transition          | Actor                                                                                       | Guard                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| → PENDING           | Holder of the active entry code                                                             | Person rostered on the project today; at most 3 PENDING rows per person; rate limits (below)                                           |
| PENDING → CONFIRMED | PM of the project, or the foreman of the person's crew on the site's today                  | `now < pendingUntil` (24 h); confirmer person ≠ device person; `expectedVersion`                                                       |
| PENDING → REJECTED  | Same as confirm                                                                             | `expectedVersion`                                                                                                                      |
| CONFIRMED → REVOKED | PM (reason required); the device itself (`release`, "not me"); a newer confirm (`REPLACED`) | Row lock `FOR UPDATE`                                                                                                                  |
| → EXPIRED           | Derived at read time, persisted on the next write                                           | PENDING past `pendingUntil`; CONFIRMED past `expiresAt` (180 d or end of assignment), idle > 30 d, or no valid crew/project assignment |
| rotate              | The device                                                                                  | Old token valid; new token well-formed; replay-safe via `prevTokenHash`                                                                |

Invariants:

- I1: `tokenHash` is globally unique, because the lookup happens before the org is known.
- I2: there is at most one CONFIRMED device per (org, project, person) (partial unique index).
- I3: `confirmedByPersonId <> personId`.
- I4: forward-only transitions (trigger).
- I5: every transition appends a `FieldDeviceEvent` and an `AuditLog` row with `actorKind` `HUMAN` or `FIELD_DEVICE`.
- I6: only an effective CONFIRMED device authenticates.

**Token.** The client creates `fd1.` + base64url(32 random bytes) and keeps it in `localStorage` (the phone test showed it survives sessions). Client generation makes a lost bind response safe to retry: the retry carries the same token, so the same hash maps to the same row, and the server never holds plaintext for replay. A token a malicious client picks itself grants nothing until a human confirms it. The token is never put in a URL, query, QR code, log, audit row, error body or response.

**Entry code / QR.** The QR code is `https://<app-host>/field#e=<entryCode>`. The fragment never reaches server access logs, and the PWA posts the code in a body. The code (128 bits, one active per project) only allows reading the roster picker and requesting a binding. It is stored as issued, because it is printed publicly and is not a credential. The PM rotates it at once when a poster leaks. Old codes then return `ENTRY_CODE_INVALID`.

**Rotation and revocation.** The client rotates a CONFIRMED token every 30 days of use. Every field request re-reads the device row inside its own transaction; there is no cache. A check-in takes `FOR SHARE` and revoke takes `FOR UPDATE`, so a check-in either commits before the revoke or sees REVOKED.

**Rate limits** (Postgres fixed windows, no Redis). The limits count per hashed client IP, using a daily random salt kept in the DB and dropped after 48 h:

- Entry/roster reads: 20 per 10 min per IP-hash.
- Bind: 10 per hour per IP-hash and 60 per hour per entry code.
- Unknown or ended tokens: 20 per 10 min per IP-hash, after which all field calls from that hash get `429`.
- Failed check-ins: 30 per hour per device.

Every `429` carries `Retry-After`.

## 3. Check-in rules

| Topic         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slot          | One non-voided `WorkerCheckIn` per (org, project, person, businessDate): partial unique index plus an advisory lock on the same key. The same person on another project the same day is allowed, flagged `MULTI_PROJECT_DAY` and never added up as time.                                                                                                                                                                                                     |
| Business day  | `businessDate = localDate(occurredAt, Project.timezone)`. The client sends the date it displayed; a mismatch is `BUSINESS_DAY_MISMATCH`, never silently re-dated. Example (TEST, UTC+2 site): `occurredAt 2026-10-01T22:30Z` → `2026-10-02`.                                                                                                                                                                                                                 |
| Times         | `occurredAt` (device clock at tap), `deviceSentAt` (device clock at send), `fixAt` (location fix), `receivedAt` (server, request start), `recordedAt` (insert `now()`). They are stored separately and none is copied into another.                                                                                                                                                                                                                          |
| Clock checks  | `abs(receivedAt − deviceSentAt) > 5 min` → `DEVICE_CLOCK_SKEW`. The server does not correct a claimed time. `occurredAt > receivedAt + 1 min` → `OCCURRED_IN_FUTURE`. `fixAt` more than 2 min before `occurredAt` → `STALE_FIX`.                                                                                                                                                                                                                             |
| Late          | `receivedAt − occurredAt ≤ 15 min`: normal. 15 min to 24 h: accepted with `LATE`. Over 24 h: `TOO_LATE` (use a PM proxy). A6 keeps no offline queue (A8); the page retries with the same key while it is open.                                                                                                                                                                                                                                               |
| Geofence      | Reference point = latest `ProjectSiteReference` (default radius 500 m). Self check-in: `accuracyM > 100` → `LOCATION_TOO_COARSE`; haversine distance > radius → `GEOFENCE_OUTSIDE`; accepted but `distance + accuracy > radius` → flag `NEAR_EDGE`. No reference set → `SITE_NOT_CONFIGURED`. The row stores lat/lon (Decimal 9,6 as strings), accuracy, integer metres of distance and the reference `n` used.                                              |
| Why reject    | U2.1 rule 9 and the check-in decisions require a location inside the site. GPS is still only a claim: rejection filters obvious remote attempts, and a person really present with bad GPS still gets recorded through the proxy path. A rejected attempt appends a `FieldDeviceEvent` with the reason and distance rounded to 100 m, **without coordinates**.                                                                                                |
| Proxy         | The actor is the foreman of the person's crew on `businessDate` (device) or a PM (Entra). Worker devices get `PROXY_NOT_ALLOWED`. A foreman proxy needs the foreman's own fix inside the fence. A PM proxy records the PM's location if available and is flagged `REMOTE_PROXY` otherwise (see Q3). Stored: `kind=PROXY`, actor person, actor device or account, actor location.                                                                             |
| Selfie        | Optional (spec: manual spot checks only). A per-project switch defaults **off** until HR/legal confirm. When on: the client re-encodes the image (drops EXIF) and uploads it to the private evidence container under `selfie/`. The row keeps `sha256` and the blob key. Only a PM of the project can read it, through the API. It is never logged, never in list responses and never in snapshots (only `hasSelfie`). No face recognition and no templates. |
| Void          | PM only, reason required. It sets void columns once (trigger-guarded) and frees the slot. It never deletes the row or touches a submitted revision.                                                                                                                                                                                                                                                                                                          |
| Present       | A check-in is the claim "P was on site at `occurredAt`", made by P or a proxy. Headcount = distinct persons with a non-voided check-in, split self / proxy / flagged. It does not mean on site now, a full day, verified or hours. It is never multiplied and never written into `facts.people`/`facts.presence`; differences from the PM's declared counts are shown, not judged.                                                                           |
| Submitted day | Still accepted (a past fact that the worker cannot correct) and flagged `afterSubmission` (received after the day's last submit). It enters a revision only if the PM corrects. This deliberately differs from A5 photos (`LOCKED`), because the field actor has no correction path.                                                                                                                                                                         |
| Idempotency   | Every POST carries `clientMutationId` → `IdempotencyRecord(actorId = deviceId or accountId, route, key)`. Same key and body → the original response. Same key, different body → `IDEMPOTENCY_KEY_REUSED`. A new key after success → `ALREADY_CHECKED_IN`, returning the existing check-in's time and kind only; the client treats this as done.                                                                                                              |

## 4. Foreman quantity reports

- **Shape.** `ForemanReport` is one header per (project, day, crew). Each submit appends a `ForemanReportRevision` with: `n`, the rows `[{itemKey, qty}]`, a note (≤ 500), `occurredAt`, `receivedAt` and the submitting person and device. `itemKey` must be a `ReportItem` of kind `work` in the project (`ITEM_NOT_FOUND`). `qty` is a decimal string within Decimal(20,6), `unknown`, `na` or blank. Blank rows are dropped, an explicit `0` is kept, and any other form is `NUMBER_INVALID`. There are no hour fields. The crew's check-in count is displayed, not stored in the report.
- **Concurrency.** The submit carries `expectedRevision` (0 for the first). A mismatch is `REVISION_CONFLICT`, so an older screen never overwrites a newer revision. Revisions have no UPDATE or DELETE grant.
- **Totals** = the latest revision per crew. Per item: the sum of known decimals, the crews reporting `unknown`/`na`, and "N of M active crews reported". **`foremanTotals` must be extended** to return completeness. Today it skips tokens and returns a bare sum, which would present a partial total as exact.
- **Adopt** (PM, Entra) sends `{item, expectedVersion (DailyClose), basis: [{crewId, n}]}`. The server recomputes the total from the current latest revisions:
  - The latest revisions differ from `basis` → `FOREMAN_TOTAL_CHANGED` (a stale view).
  - The total is partial → `ADOPT_PARTIAL`; the PM may still type a value.
  - The day is locked → `LOCKED` (allowed during a correction).
  - Otherwise the server writes `facts.qty[item]` and appends a `ForemanAdoption` row with the value, the basis and the actor. It never adopts automatically, and a foreman submit never writes facts.
- **Snapshot** at submit freezes: the per-crew latest revisions (ids and `n`), the totals with completeness, the day's adoptions, and the check-in list without coordinates. The foreman total is the claim; `facts.qty` is the PM value. A difference between them is displayed, not treated as an issue.
- **Multiple foremen.** Each crew has one FOREMAN assignment per date. A foreman replaced mid-day hands the same revision chain to the new foreman, who must pass `expectedRevision`. Different crews reporting the same item are summed, because they are separate crews' work. Overlap cannot be detected and is not assumed; the PM sees a per-crew breakdown. A person is in at most one crew per project and date, enforced in the store under a lock and tested.

## 5. Sequences

```text
A. First scan → bind → confirm → check-in
Worker PWA                      API /api/field                 DB
 scan QR → /field#e=CODE
 POST entry {entryCode}  ─────▶ throttle; resolve code (RLS by code hash) ─▶ roster (display names)
 pick self; token=random256
 POST bind {code, personId, token, key} ─▶ throttle; hash; INSERT FieldDevice PENDING ─▶ event BIND
   ◀── {deviceId, PENDING}
 POST checkin ───────────────▶ DEVICE_PENDING (event CHECKIN_REJECTED)
Foreman PWA / PM web: list pending ─▶ confirm {deviceId, expectedVersion}
   ─▶ lock row; guard crew/role/≠self; PENDING→CONFIRMED; revoke older CONFIRMED (REPLACED); audit
 POST checkin {key, businessDate, occurredAt, deviceSentAt, fix} ─▶ auth(hash→device FOR SHARE)
   ─▶ clock/fix/fence checks ─▶ advisory lock (project, person, date) ─▶ INSERT WorkerCheckIn ─▶ 200

B. Revoked device
PM: revoke ─▶ device FOR UPDATE → REVOKED (commit)
Worker: POST checkin ─▶ auth reads REVOKED ─▶ 401 DEVICE_ENDED (no project or person data); PWA shows "bind again"
(in-flight check-in holding FOR SHARE commits first; revoke waits; nothing lands after the revoke commits)

C. Duplicate / retry
POST checkin key=K ─▶ committed, response lost
POST checkin key=K (same body) ─▶ IdempotencyRecord hit ─▶ same 200 body
POST checkin key=K2 ─▶ slot taken ─▶ 409 ALREADY_CHECKED_IN {occurredAt, kind}
POST checkin key=K (different body) ─▶ 409 IDEMPOTENCY_KEY_REUSED

D. Foreman proxy
Foreman PWA: POST checkin/proxy {personId, key, occurredAt, foreman fix}
 ─▶ auth foreman device ─▶ CrewAssignment(foreman, crew, businessDate) ∋ person? else PROXY_NOT_ALLOWED
 ─▶ foreman fix inside fence ─▶ slot lock ─▶ INSERT kind=PROXY, actorPersonId, actorDeviceId, actor location

E. Foreman report → PM adopt
Foreman: GET report (latest n=1) → POST report {expectedRevision:1, rows, note, key} ─▶ n=2
PM web: GET day → sees "foreman 120 (2/2 crews)", basis [{B,2},{C,1}]
Foreman C: POST report {expectedRevision:1} ─▶ C n=2   (PM view is now stale)
PM: POST adopt {item, expectedVersion, basis [{B,2},{C,1}]} ─▶ 409 FOREMAN_TOTAL_CHANGED ─▶ reload
PM: POST adopt {basis [{B,2},{C,2}]} ─▶ facts.qty[item]=total; ForemanAdoption appended; DailyClose version+1
```

## 6. Data model sketch

Every table has `orgId`. Every tenant FK is composite `(orgId, x)`. RLS uses policy `alpha_org` (`orgId = app.org_id`) for `mje_alpha_app`, as in earlier migrations. Everything is additive in one new migration.

| Table                                | Key columns                                                                                                                                                                                                                                                                                          | Constraints / grants                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Crew`                               | projectId, code, name, activeFrom/Until                                                                                                                                                                                                                                                              | unique (orgId, projectId, code); SELECT, INSERT, UPDATE(activeUntil)                                                                                                                                                                                                                                |
| `CrewAssignment`                     | crewId, personId, role `MEMBER`/`FOREMAN`, validFrom/validUntil (date)                                                                                                                                                                                                                               | at most one open FOREMAN per crew (partial unique); append rows, only `validUntil` updatable                                                                                                                                                                                                        |
| `ProjectSiteReference`               | projectId, n, lat/lon Decimal(9,6), radiusM (50–2000), setByAccountId, setAt                                                                                                                                                                                                                         | unique (orgId, projectId, n); SELECT, INSERT only                                                                                                                                                                                                                                                   |
| `FieldEntryCode`                     | projectId, code (128-bit), createdBy, retiredAt                                                                                                                                                                                                                                                      | one active per project (partial unique); lookup policy on `app.entry_code`                                                                                                                                                                                                                          |
| `FieldDevice`                        | projectId, personId, state, tokenHash bytea, prevTokenHash, tokenGeneration, entryCodeId, pendingUntil, confirmedAt/ByPersonId/ByAccountId/ByDeviceId, endedAt/ByPersonId/endReason, expiresAt, lastSeenAt, version                                                                                  | unique tokenHash (global); partial unique (orgId, projectId, personId) WHERE state='CONFIRMED'; CHECK confirmer ≠ person; forward-only trigger; UPDATE grant on state/lifecycle/hash columns only; extra SELECT policy `tokenHash = app.device_token_hash` (as `LoginAccount` uses `app.object_id`) |
| `FieldDeviceEvent`                   | deviceId?, projectId, kind, reasonCode, distanceBucketM, at, actor                                                                                                                                                                                                                                   | append-only (SELECT, INSERT); no coordinates                                                                                                                                                                                                                                                        |
| `WorkerCheckIn`                      | projectId, personId, businessDate, kind SELF/PROXY, deviceId, actorPersonId, actorAccountId, actorDeviceId, occurredAt, deviceSentAt, fixAt, receivedAt, recordedAt, lat, lon, accuracyM, distanceM, siteRefN, actorLat/Lon/AccuracyM, flags text[], selfieSha256, selfieBlobKey, voidedAt/By/Reason | partial unique (orgId, projectId, personId, businessDate) WHERE voidedAt IS NULL; index (orgId, projectId, businessDate); trigger: only the void columns, once                                                                                                                                      |
| `ForemanReport`                      | projectId, businessDate, crewId, currentN                                                                                                                                                                                                                                                            | unique (orgId, projectId, businessDate, crewId); UPDATE(currentN) only                                                                                                                                                                                                                              |
| `ForemanReportRevision`              | reportId, n, rows jsonb, note, byPersonId, byDeviceId, occurredAt, receivedAt                                                                                                                                                                                                                        | unique (orgId, reportId, n); SELECT, INSERT only                                                                                                                                                                                                                                                    |
| `ForemanAdoption`                    | projectId, businessDate, itemKey, value Decimal(20,6), basis jsonb, dailyCloseVersion, byAccountId, at                                                                                                                                                                                               | append-only                                                                                                                                                                                                                                                                                         |
| `FieldThrottle`, `FieldThrottleSalt` | bucket char(64), windowStart, count / day, salt                                                                                                                                                                                                                                                      | non-tenant, no personal data; rows older than 48 h pruned                                                                                                                                                                                                                                           |

Device authentication works like `inTransaction`: set `app.device_token_hash`, read the device through its policy, then set `app.org_id` from the row. The request body never supplies the org. `FOREMAN`/`WORKER` are **not** added to `Membership`, which requires a LoginAccount (execution plan decision 3 is revised here; see conflicts).

## 7. API sketch

Field routes accept only `Bearer fd1.*` and report routes accept only Entra JWTs; each guard rejects the other kind with 401. Any `projectId` in a field body must equal the device's project, otherwise `FORBIDDEN`. Errors keep the existing `{code, correlationId}` shape. Request bodies of `/api/field/*` are never logged.

| Field (device)                                     | Purpose                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/field/entry`                            | {entryCode} → project display name, the site's today, crews and roster display names (throttled, no device)   |
| `POST /api/field/bind`                             | {entryCode, personId, token, clientMutationId} → {deviceId, state}                                            |
| `GET /api/field/me`                                | Device state, person, crew and today's role, today's check-in; for a foreman, pending devices and crew status |
| `POST /api/field/checkin`, `/checkin/proxy`        | Self / proxy check-in (§3)                                                                                    |
| `POST /api/field/devices/:id/confirm`, `/reject`   | Foreman, own crew, `expectedVersion`                                                                          |
| `POST /api/field/device/rotate`, `/device/release` | Rotate the token; self-revoke                                                                                 |
| `GET`/`POST /api/field/report`                     | Own crew's latest revision and planned items / submit a revision                                              |
| `POST /api/field/checkin/:id/selfie`               | Only when the project switch is on                                                                            |

PM routes (Entra, `PROJECT_MANAGER`, per project): `GET /api/report/field/devices`, `POST …/devices/:id/{confirm,reject,revoke}`, `POST …/entry-code/rotate`, `POST …/site-reference`, `GET …/checkins`, `POST …/checkins/proxy`, `POST …/checkins/:id/void`, `GET …/foreman`, `POST /api/report/foreman/adopt`, and minimal `POST …/crews`, `…/crew-assignments`.

Error codes (HTTP):

- 401: `FIELD_AUTH_REQUIRED` (missing or unknown token), `DEVICE_ENDED` (revoked, rejected or expired; only the holder of the hash can learn this).
- 403: `DEVICE_PENDING`, `FORBIDDEN`, `PROXY_NOT_ALLOWED`, `NOT_FOREMAN`, `SELF_CONFIRM`, `READ_ONLY`.
- 404: `NOT_FOUND`, `ENTRY_CODE_INVALID`, `ITEM_NOT_FOUND`, `PERSON_NOT_ROSTERED`.
- 409, device and slot: `VERSION_CONFLICT`, `REVISION_CONFLICT`, `ALREADY_CHECKED_IN`, `IDEMPOTENCY_KEY_REUSED`, `TOO_MANY_PENDING`, `PENDING_EXPIRED`.
- 409, adoption: `FOREMAN_TOTAL_CHANGED`, `ADOPT_PARTIAL`, `LOCKED`.
- 409, check-in timing and location: `BUSINESS_DAY_MISMATCH`, `DEVICE_CLOCK_SKEW`, `OCCURRED_IN_FUTURE`, `STALE_FIX`, `TOO_LATE`, `GEOFENCE_OUTSIDE`, `LOCATION_TOO_COARSE`, `SITE_NOT_CONFIGURED`.
- 400: `INVALID_INPUT` (including a malformed token or `NUMBER_INVALID`).
- 413/415: selfie size or type.
- 429: `RATE_LIMITED`.

## 8. Required negative tests (integration, isolated TEST DB, low-privilege role)

| AGENTS.md class                        | A6 case                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stale response overwrites newer state  | Adopt with an old basis → `FOREMAN_TOTAL_CHANGED`. A foreman submit on `expectedRevision` n−1 → `REVISION_CONFLICT`. PM confirm with an old `expectedVersion` after a revoke → `VERSION_CONFLICT`. A check-in racing a revoke under controlled lock timing: nothing commits after the revoke.                                                                                                                                                                                                                                                                                                                                                                            |
| Unknown treated as exact (incl. 0)     | A crew with `unknown` makes the total partial and adopt → `ADOPT_PARTIAL`. Blank ≠ `0`. A missing fix is never distance 0. `NaN`/out-of-range coordinates → `INVALID_INPUT`. A missing crew report is not zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| History rewritten                      | UPDATE/DELETE on `ForemanReportRevision`, `FieldDeviceEvent`, `ProjectSiteReference` or `ForemanAdoption` fails for the app role. Only the void columns of `WorkerCheckIn` change, once. A REVOKED device cannot return to CONFIRMED. A submitted snapshot is unchanged after later check-ins, reports, voids or site-reference edits.                                                                                                                                                                                                                                                                                                                                   |
| Empty list skips identity/tenant check | A foreman with no crew or an empty crew → `NOT_FOREMAN`, never "allowed for all". An empty roster still validates the entry code. A device whose person has no active assignment is `DEVICE_ENDED`. A proxy for a person on no crew → `PROXY_NOT_ALLOWED`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Unsanitised errors                     | No response, log line or audit row contains a token, token hash, entry code, coordinates, selfie key or another person's name. Wrong-org and unknown tokens get identical 401 bodies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Slice-specific                         | Cross-crew proxy (foreman B → crew C person); proxy by a worker device. Revoked, rejected, expired or pending token. Wrong-org token (org A device + org B projectId → `FORBIDDEN`, no row). Duplicate check-in (same key replay, new key, concurrent pair → exactly one row). Geofence edge: 499/500/501 m, accuracy 100/101 m, `NEAR_EDGE`. Timezone day boundary: 23:59/00:00 local across a DST change; a client date ≠ server-derived date. Same person with two devices: confirm the second → the first is REVOKED(REPLACED), one check-in only. Self-confirm through a second account → `SELF_CONFIRM`. Rate-limit 429. Bind retry with the same token → one row. |

## 9. Open questions for the user (recommended default in bold)

1. **Selfie:** required or optional? **Optional, and off per project until local HR/legal confirm** (spec §8). Retention: **30 days, then delete the blob and keep `hasSelfie`**.
2. **Geofence:** keep 500 m and reject? **Yes, reject self check-in (spec); per-project radius 50–2000 m; accuracy limit 100 m.**
3. **PM proxy away from the site** (for example from the office when phones fail): allow? **Allow, flagged `REMOTE_PROXY`; foreman proxy must be on site.**
4. **Can foremen confirm devices?** The spec says yes. **Yes for their own crew, shown as "confirmed by foreman" in the PM list for spot checks.**
5. **Token lifetime:** **180 days absolute or end of assignment, 30 days idle, pending 24 h; re-confirmation needed after expiry.**
6. **Late check-in window** until A8 sets the offline limit (A06): **24 h, flagged `LATE` after 15 min; older only by PM proxy.**
7. **Roster exposure:** anyone holding the QR sees display names. **Accept (rotatable code, throttled, display names only); revisit if posters leave the site.**
8. **Headcount auto-fill:** an earlier review note said the headcount becomes automatic once check-in is live. **No: show check-in counts beside the PM's declared counts; add an explicit "adopt" later if wanted.**

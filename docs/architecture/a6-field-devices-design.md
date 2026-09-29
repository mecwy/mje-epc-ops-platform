# A6 design: field devices, worker check-in and foreman quantities

Status: design r2 for review. It answers the first Codex review (12 findings) and records the user decisions of 2026-09-29. It contains no application code, migration or contract. All examples are synthetic TEST data; coordinates are `0.000000, 0.000000`-style placeholders.

Scope: U2.1 rules 1, 9, 11, 12, 13 and 14, the foreman quantity report and the PM "adopt" step.

Out of scope:

- the offline queue (A8);
- hours or timesheets;
- face recognition;
- payroll;
- mini-program or native app;
- bulk roster import;
- backdated roster changes.

## 0. Decisions

User decisions (2026-09-29):

| #   | Decision                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Selfie is optional and off by default per project. It is enabled only after HR/legal confirm.                                                                                                                 |
| U2  | Self check-in is rejected outside the project radius (default 500 m, adjustable 50–2000 m per project) or with accuracy worse than 100 m. The fact can be recorded by an on-site foreman proxy or a PM proxy. |
| U3  | A PM may proxy off site. A known off-site location is flagged `REMOTE_PROXY`. A foreman proxy must be on site.                                                                                                |
| U4  | Foremen confirm devices of their own current crew. The PM list marks these for spot checks.                                                                                                                   |
| U5  | Token lifetime: 180 days or end of project membership, 30 days idle, pending 24 h.                                                                                                                            |
| U6  | Late self or foreman check-in: up to 24 h by device clock, flagged `LATE` after 15 min. Older facts only by PM proxy.                                                                                         |
| U7  | Anyone holding the QR code sees current display names. This is an intentional disclosure: rotating the code stops future reads but cannot retract names already seen.                                         |
| U8  | Headcount is never filled from check-ins. Check-in counts are shown beside the PM's declared counts.                                                                                                          |

Design rules:

- A FieldDevice is a browser-held secret for one Person on one project. It proves only that a PM or the crew foreman confirmed, face to face, the browser showing a challenge. It proves nothing about identity, presence or who holds the phone. Server-side, one handset cannot be told from another; we do no fingerprinting. Organized proxying is handled by confirmation, flags and spot checks, never by automatic judgement.
- Roles are never on the device. Authority is recomputed per request from timestamp-effective `CrewAssignment` rows. The project comes from the device, never from a field request body.
- A check-in is the claim "P was on site at T". It never becomes hours and never writes `facts.people` or `facts.presence`.
- Foreman totals are claims. The PM adopts a total explicitly, and only when it is complete. A submitted revision never changes (rule 1).
- **Prerequisite, PR A6.0:** enforce OD18 on the server before any A6 field reaches a read path. An `EXECUTIVE_READER` gets `GET day`/`days`/`revision` as either "not submitted" or the latest frozen revision, also during a correction. It never gets live facts, foreman data, check-ins or adoption controls. Tests go through HTTP. Later A6 PRs add field data to `GET day` only in the writer branch.

## 1. Identity, roster and authority

| Concept                             | Rule                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person / LoginAccount / FieldDevice | Person is the natural person. LoginAccount is an optional Entra account. FieldDevice is a per-project possession credential. Check-in uniqueness is per Person, so extra devices or accounts add nothing. A person with two accounts is still one Person for `SELF_CONFIRM`. |
| `CrewAssignment`                    | Append-only interval rows (`MEMBER` of crew C, or `FOREMAN` of C), half-open `[validFrom, validUntil)` as timestamptz. A new row needs `validFrom ≥ now − 5 min`. The only update allowed is setting `validUntil ≥ now`, once. Past intervals are never rewritten.           |
| Non-overlap                         | Per (project, person), `MEMBER` intervals never overlap. Per crew, `FOREMAN` intervals never overlap. A person is `FOREMAN` of at most one crew at a time. This is enforced by a trigger under the person or crew advisory lock and tested concurrently.                     |
| Handover                            | Foreman A → B at T is one transaction: close A's row at T and open B's at T. A loses authority at T. A move between crews works the same way and keeps the device.                                                                                                           |
| Durable termination                 | Closing a person's last open `MEMBER` interval in the project revokes their CONFIRMED device and rejects PENDING ones in the same transaction (`UNASSIGNED`). Reassignment needs a new binding.                                                                              |
| Actor authority                     | Always evaluated at `receivedAt` (now), never at a time the caller picks. Foreman writes need an open `FOREMAN` row for the subject's crew at now.                                                                                                                           |
| Subject membership                  | For a check-in, P must be a `MEMBER` of the crew at `occurredAt`. For a foreman proxy, it must also hold at now.                                                                                                                                                             |
| Historical writes                   | A foreman may write only for the site's today or yesterday, within the U6 window, and only with current authority. There is no delegation. Anything older is PM-only, and the PM needs current project membership.                                                           |

## 2. FieldDevice lifecycle

```text
bind ─▶ PENDING ──confirm (challenge)──▶ CONFIRMED ──revoke / release / replaced / unassigned──▶ REVOKED
          │  └─reject / superseded──▶ REJECTED            │ rotate: same state, generation+1
          └─pendingUntil passed──▶ EXPIRED ◀──idle 30 d / expiresAt──┘
```

Terminal states never return. Rebinding creates a new row. An expired device is detected at authentication and persisted in the same transaction. `CHECK` constraints:

- CONFIRMED ⇒ `confirmedAt` and `confirmedByPersonId` are NOT NULL, exactly one of `confirmedByAccountId`/`confirmedByDeviceId` is set, and `confirmedByPersonId <> personId`.
- Ended states ⇒ `endedAt` and `endReason` are NOT NULL.
- A trigger allows only forward transitions.

**Confirmation ceremony.** After binding, the pending browser calls `POST /api/field/device/challenge`. The server stores a new random 6-digit code, hashed, bound to `(deviceId, deviceVersion, personId, projectId)`. It expires in 5 min, can be used once and allows 5 attempts; a new challenge supersedes the old one. The browser shows the code and the chosen display name. The confirmer, standing with the worker, checks the name and types the code: `confirm {personId, code, expectedCurrentDeviceId}`. The confirmer never picks a row. The server looks for the one PENDING device of that person whose live challenge matches and whose bound version equals the row's version. No match → `CHALLENGE_INVALID`, which counts as an attempt. The bearer token is never the challenge. Two competing binds for one person produce two different codes, and only the browser physically shown gets confirmed.

**Confirm, serialized per (org, project, person).** Lock order is in §5. The transaction:

1. Locks the person.
2. Re-reads the target and the person's current CONFIRMED device.
3. If the current confirmed device ≠ `expectedCurrentDeviceId`, returns `CONFIRM_STALE`. The confirmer's view was old: another phone was confirmed or revoked meanwhile.
4. Revokes the current device (`REPLACED`) **before** confirming the target.
5. Rejects every other PENDING device of the person (`SUPERSEDED`).
6. Confirms the target and burns the challenge.

The partial unique index "one CONFIRMED per person and project" holds at every step.

**Token and rotation.** The token is `fd1.` + base64url(32 random bytes), generated on the device. Every accepted hash is inserted into `FieldTokenHash` (PK = hash) and never reused, so a replayed or chosen token can never match another device's current or previous hash (`TOKEN_CONFLICT`). The body exception: only `bind` (token) and `rotate` (new token) carry a secret in the body. These bodies are excluded from logs, and their idempotency hash covers `sha256(token)`, never the token.

Rotation runs every 30 days of use, from one tab, under a Web Locks lock:

| Step          | Client                                                                         | Server                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1             | Generate N. Persist `{current:O, pending:N, generation:g}` **before** sending. |                                                                                                                                                                                           |
| 2             | `POST rotate` with `Bearer O`, body `{newToken:N, expectedGeneration:g}`       | Bootstrap auth (§5) and lock the device. If hash(O) = current and generation = g: set `prevTokenHash`=hash(O), current=hash(N), generation g+1, and insert hash(N) into `FieldTokenHash`. |
| 3             | 200 → `current=N`, clear pending                                               |                                                                                                                                                                                           |
| Lost response | Retry the same O, N, g                                                         | hash(O) = `prevTokenHash`, current = hash(N), generation = g+1 → return the same 200. **This is the only request the previous hash may make.** Any other use → `FIELD_AUTH_REQUIRED`.     |
| Stale tab     | 401 while pending is set → try `GET me` with N; if it works, adopt N           | Generation ≠ g with a current hash → `VERSION_CONFLICT`                                                                                                                                   |

`prevTokenHash` is cleared on the first request authenticated with the new token, or after 7 days. Revoke and rotate both lock the device row, and a revoked device accepts neither.

**Entry code.** The QR code is `https://<app-host>/field#e=<code>`. The fragment is never sent to the server. The code (128-bit, one active per project, PM-rotated) allows only the roster read and bind (U7).

**Throttling** uses Postgres fixed windows, no Redis. IP-hash is the client IP hashed with a daily DB salt that is dropped after 48 h. Limits are sized for a whole crew behind one site NAT or carrier-grade NAT:

| Request         | Limit                                                                             |
| --------------- | --------------------------------------------------------------------------------- |
| Entry           | 300 / 10 min per IP-hash; 600 / 10 min per code                                   |
| Bind            | 150 / h per IP-hash; 300 / h per code; ≤ 3 PENDING per person                     |
| Challenge       | 10 / h per device; 5 attempts per challenge; 30 failed confirms / h per confirmer |
| Unknown token   | 60 / 10 min per IP-hash                                                           |
| Failed check-in | 30 / h per device                                                                 |

## 3. Check-in

**Event vs transport.** The idempotency hash covers the route plus the canonical _event_. For self and foreman-proxy check-ins the event is: `personId` (proxy only), `businessDate`, `occurredAt`, `fix {lat, lon, accuracyM, fixAt}` and `stagedSelfieId?`. _Transport_ data is `deviceSentAt` (the device clock at this attempt) and is not hashed. A retry keeps the key and event and refreshes `deviceSentAt`. The row stores the committing attempt's `deviceSentAt`, `receivedAt` and `clockSkewMs`, plus `recordedAt` (the transaction time) and `siteTimezone` (the timezone used).

**Order of processing:**

1. Parse.
2. Bootstrap auth (§5).
3. Resource authorization (§6).
4. Idempotency lookup. A hit returns the stored result with **no** time or geofence rules re-run; a changed body → `IDEMPOTENCY_KEY_REUSED`.
5. Time admission.
6. Geofence.
7. Locks and slot.
8. Insert.

**Time admission** (self and foreman proxy, first attempt only):

| #   | Rule                                                                                                            | Error                   |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------- |
| T1  | `fixAt ≤ occurredAt ≤ fixAt + 2 min`. No fix from the future and none staler than 2 min.                        | `FIX_TIME_INVALID`      |
| T2  | `occurredAt ≤ deviceSentAt`                                                                                     | `TIME_ORDER_INVALID`    |
| T3  | `abs(receivedAt − deviceSentAt) ≤ 5 min`, which also bounds `occurredAt ≤ receivedAt + 5 min`. Never corrected. | `DEVICE_CLOCK_SKEW`     |
| T4  | Age = `deviceSentAt − occurredAt` (same clock): ≤ 15 min normal; ≤ 24 h flag `LATE`; beyond that rejected       | `TOO_LATE`              |
| T5  | `localDate(occurredAt, project.timezone) = body.businessDate`, computed with the tz database, so DST-safe       | `BUSINESS_DAY_MISMATCH` |

**Geofence** (self; foreman proxy uses the foreman's fix). Reference = the latest `ProjectSiteReference`.

| Condition                                  | Result                |
| ------------------------------------------ | --------------------- |
| Accuracy > 100 m                           | `LOCATION_TOO_COARSE` |
| Distance > radius                          | `GEOFENCE_OUTSIDE`    |
| Accepted with distance + accuracy > radius | Flag `NEAR_EDGE`      |
| No reference                               | `SITE_NOT_CONFIGURED` |

A rejection appends a `FieldDeviceEvent` with the reason and distance in 100 m buckets, **without coordinates**. It is a request error, never a finding.

**PM proxy** (Entra) has its own admission:

| Field               | Rule                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `businessDate`      | Site today back to today − 7 days; older → `TOO_LATE`                                                                                                                         |
| `occurredAt`        | Optional. If given: ≤ `receivedAt` and inside `businessDate` locally (`timePrecision=EXACT`). If absent: `timePrecision=DAY`, never invented.                                 |
| `source` + `reason` | `OBSERVED_ON_SITE`, `FOREMAN_REPORTED` or `OTHER`. The reason is required when the date is not today or when no in-fence fix exists.                                          |
| Actor fix           | Optional current PM fix with `fixAt` within 2 min of `receivedAt`. It is stored in the `actor*` columns only, never as the worker's location; the worker's lat/lon stay null. |
| Flags               | Inside → none. `distance − accuracy > radius` → `REMOTE_PROXY`. Accuracy > 100 m or ambiguous → `PROXY_LOCATION_COARSE`. No fix → `PROXY_LOCATION_UNAVAILABLE`.               |

Planned `checkinDecision` change: the manager branch no longer needs an in-fence location and returns flags. The self and foreman branches keep the hard fence.

**Other rules:**

- **Slot:** one non-voided check-in per (project, person, businessDate), backed by a partial unique index and the slot lock. A replay returns the original. A new key → `ALREADY_CHECKED_IN` with `{occurredAt, kind}` only. Another project the same day is allowed and flagged `MULTI_PROJECT_DAY`.
- **Void:** PM only, reason required. Void columns are set once and record `voidSeq`.
- **Present:** headcount is the number of distinct persons with a non-voided check-in, split self / proxy / flagged. It does not mean "on site now", a full day, verified, or hours.
- **Selfie (U1)** is a staged, append-only flow:
  1. `POST /api/field/selfie` (self only, idempotent on key + sha256) stores the blob under the private `selfie/` prefix and a `FieldSelfie` row owned by (device, person, project). It expires in 1 h if unattached.
  2. The check-in body references `stagedSelfieId`. The check-in transaction checks the owner (same device, person and project, unexpired, unattached) and inserts `CheckInSelfie(checkInId UNIQUE, selfieId UNIQUE)`. There is no later attachment and no replacement.
  3. The snapshot keeps only `hasSelfie`. Reads go through a PM-only proxy.
  4. Retention: after 30 days a worker deletes the blob and sets `FieldSelfie.deletedAt` once (audited). `hasSelfie` stays, marked deleted. Unattached staged blobs are deleted after 1 h.
  5. This needs Blob delete permission for the worker identity, which is an infra item.

## 4. Foreman quantity reports

- **Revision:** `ForemanReport` has one header per (project, date, crew). `ForemanReportRevision` holds:
  - `n` and `expectedRevision` → `REVISION_CONFLICT`;
  - rows `[{itemKey, qty}]`: the key must be a project `work` item (`ITEM_NOT_FOUND`), and a duplicate key → `INVALID_INPUT`;
  - `qty`: a decimal within Decimal(20,6), `unknown`, `na`, or blank, stored as blank rather than dropped; anything else → `NUMBER_INVALID`;
  - a note (≤ 500), `occurredAt`, `receivedAt` and `siteTimezone`.

  There are no hour fields. Revisions are insert-only.

- **Expected crew set** for (project, date): crews with a `FOREMAN` interval overlapping the business day in the site timezone. It is computed under the day lock.
- **Per item, per expected crew**, the status is one of `MISSING_REPORT`, `OMITTED` (item absent or blank), `UNKNOWN`, `NA`, `ZERO` or `VALUE`.

| Item total            | Condition                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `COMPLETE` value      | Every expected crew is `ZERO`, `VALUE` or `NA`, at least one is `ZERO`/`VALUE`, and the sum fits Decimal(20,6) |
| `ALL_NA` (nonnumeric) | Every expected crew is `NA`                                                                                    |
| `PARTIAL`             | Any `MISSING_REPORT`/`OMITTED`/`UNKNOWN`; the known subtotal is shown as "≥"                                   |
| `OVERFLOW`            | The sum is outside Decimal(20,6); no number is shown                                                           |

Only `COMPLETE` can be adopted; the PM may still type any value. `foremanTotals` will return this structure instead of a bare sum.

- **Adopt:** the PM sends `{item, expectedVersion, basis: {expectedCrews: [crewId], revisions: [{crewId, n|null}]}}`. Under the lock order (§5) the server recomputes the expected crew set and the latest revisions:
  - Any difference, including roster changes → `FOREMAN_TOTAL_CHANGED`.
  - A total that is not `COMPLETE` → `ADOPT_NOT_COMPLETE`.
  - A locked day → `LOCKED`, unless a correction is open.
  - Otherwise the server writes `facts.qty[item]` and appends a `ForemanAdoption` row with the basis, value and `daySeq`.

  Nothing is adopted automatically.

- **Snapshot at submit,** read under the day lock:
  - the expected crew set;
  - the latest revision ids and `n` per crew;
  - per-item statuses and totals;
  - adoptions;
  - check-ins without coordinates;
  - `fieldSeqBoundary` (below).

  The foreman value is the claim and `facts.qty` is the PM value. A difference is shown, not treated as an issue.

## 5. Transactions and lock order

**Bootstrap (field routes, low-privilege `mje_alpha_app`):**

1. Set `app.device_token_hash`, then do a **non-locking** SELECT through the lookup policy, which is SELECT-only and returns `orgId, id, personId`.
2. Set `app.org_id` (transaction-local).
3. Lifecycle routes take the person locks of the actor and the subject, sorted, before any device row lock.
4. Do a locked re-read through `alpha_org` (`FOR SHARE`; `FOR UPDATE` for rotate or release). Revalidate the hash, state, expiry and current membership.

Transaction-local settings end at commit or rollback. A pooled-connection test checks that no context leaks.

**Global lock order.** Every transaction takes locks in this order, skipping levels it does not need:

1. Person advisory locks `(org, project, person)`, sorted.
2. `FieldDevice` rows, sorted by id.
3. `DailyClose` row `FOR UPDATE`.
4. `lockReportDay(org, project, date)`.
5. Slot or crew-report advisory locks.
6. Target rows (`ForemanReport`, `WorkerCheckIn`).
7. The `FieldDay` counter row.

| Operation                                          | Locks taken                                |
| -------------------------------------------------- | ------------------------------------------ |
| Self or foreman check-in                           | 2 (actor share) → 4 → 5 → 7                |
| PM proxy, void                                     | 4 → 5/6 → 7                                |
| Foreman report                                     | 2 → 4 → 6 → 7                              |
| Adopt, day submit                                  | 3 → 4 → 7 (submit reads; adopt increments) |
| Confirm, reject, revoke, release, rotate, unassign | 1 → 2                                      |

**Submission boundary.** Each field write for a day increments `FieldDay.lastSeq` under the day lock and stores `daySeq` on its row. Those writes are check-in, void (`voidSeq`), foreman revision and adoption. Submit records `fieldSeqBoundary = lastSeq` under the same lock. A revision contains exactly the rows with `daySeq ≤ boundary`, minus voids with `voidSeq ≤ boundary`. Rows above the boundary are `afterSubmission`; they enter only through a correction. Receipt timestamps are never used for this.

**Revocation ordering.** Every privileged field write holds its actor device lock until commit: check-in, proxy, confirm, reject, report, selfie, rotate. Revoke needs `FOR UPDATE`, so a write either commits before the revoke or sees REVOKED.

## 6. Endpoint matrix

Field routes accept only `Bearer fd1.*` (entry and bind are the exceptions) and PM routes accept only Entra JWTs. Field bodies carry no `projectId`: the project is the device's. A target `:id` or `personId` outside that project, in another org or nonexistent → `NOT_FOUND`. An unknown token from any org → `FIELD_AUTH_REQUIRED`, with identical bodies. A replay re-runs authentication and resource checks before returning the stored result. IdempotencyRecord `actorId` is the device id or account id.

| Endpoint                                                                                                                                                        | Auth                                              | Idempotency                                               | Resource checks                                                                                                  | Main errors                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST field/entry`                                                                                                                                              | Entry code                                        | none (read)                                               | Active code                                                                                                      | `ENTRY_CODE_INVALID`, `RATE_LIMITED`                                                                                     |
| `POST field/bind`                                                                                                                                               | Entry code                                        | `sha256(token)`: same token + person + project → same row | Person is a current project member                                                                               | `TOKEN_CONFLICT` (same token with another person or project, or a known hash), `TOO_MANY_PENDING`, `PERSON_NOT_ROSTERED` |
| `GET field/me`                                                                                                                                                  | Any non-ended device, incl. PENDING               | —                                                         | Own device                                                                                                       | `DEVICE_ENDED`                                                                                                           |
| `POST field/device/challenge`                                                                                                                                   | PENDING device                                    | none (new challenge each time)                            | Own device                                                                                                       | `RATE_LIMITED`                                                                                                           |
| `POST field/device/release`                                                                                                                                     | Own device                                        | key                                                       | Own                                                                                                              | —                                                                                                                        |
| `POST field/device/rotate`                                                                                                                                      | CONFIRMED, or prev hash for an exact replay       | §2 protocol                                               | Own                                                                                                              | `VERSION_CONFLICT`, `TOKEN_CONFLICT`                                                                                     |
| `POST field/devices/confirm`, `/reject`                                                                                                                         | CONFIRMED foreman                                 | key                                                       | Subject is a current member of the actor's current crew; not self                                                | `NOT_FOREMAN`, `CHALLENGE_INVALID`, `CONFIRM_STALE`, `SELF_CONFIRM`                                                      |
| `POST field/selfie`                                                                                                                                             | CONFIRMED                                         | key + sha256                                              | Own person; project switch on                                                                                    | `FEATURE_OFF`, 413/415                                                                                                   |
| `POST field/checkin`                                                                                                                                            | CONFIRMED (PENDING → `DEVICE_PENDING`)            | key + event                                               | Own person; member at `occurredAt`                                                                               | T1–T5, geofence codes, `ALREADY_CHECKED_IN`                                                                              |
| `POST field/checkin/proxy`                                                                                                                                      | CONFIRMED foreman                                 | key + event                                               | Subject in the actor's current crew at now and at `occurredAt`                                                   | `PROXY_NOT_ALLOWED`, as above                                                                                            |
| `GET`/`POST field/report`                                                                                                                                       | CONFIRMED foreman                                 | key + event                                               | Own current crew; date today or yesterday                                                                        | `REVISION_CONFLICT`, `NUMBER_INVALID`, `ITEM_NOT_FOUND`                                                                  |
| PM `report/field/*`: devices list, confirm, reject, revoke; entry-code rotate; site reference; crews and assignments; check-ins list, proxy, void; foreman view | Entra `PROJECT_MANAGER` of the resource's project | key (writes)                                              | Resource belongs to the project; crew, person and device in the same project (composite FKs include `projectId`) | `FORBIDDEN`, `READ_ONLY`, `VERSION_CONFLICT`, `CONFIRM_STALE`                                                            |
| `POST report/foreman/adopt`                                                                                                                                     | Entra PM                                          | key                                                       | Item in the project                                                                                              | `FOREMAN_TOTAL_CHANGED`, `ADOPT_NOT_COMPLETE`, `LOCKED`                                                                  |

HTTP statuses:

- 400: `INVALID_INPUT` (contract parse errors, including a duplicate item key).
- 401: `FIELD_AUTH_REQUIRED`, `DEVICE_ENDED`.
- 403: `DEVICE_PENDING`, `FORBIDDEN`, `READ_ONLY`, `NOT_FOREMAN`, `PROXY_NOT_ALLOWED`, `SELF_CONFIRM`, `FEATURE_OFF`.
- 404: `NOT_FOUND`, `ENTRY_CODE_INVALID`, `ITEM_NOT_FOUND`, `PERSON_NOT_ROSTERED`.
- 429: `RATE_LIMITED`.
- 409: all other domain codes, including `NUMBER_INVALID` as today.

A Postgres deadlock or serialization failure → 503 `RETRY`, which is safe to repeat with the same key. Error bodies stay `{code, correlationId}` and never contain a token, hash, entry code, challenge, coordinates, selfie key or another person's name.

## 7. Data model (one additive migration; `orgId` on every table; composite tenant FKs; RLS `alpha_org`)

| Table                                | Key columns and constraints                                                                                                                                                                                                                                                                                                                                                                         | App grants                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `Crew`                               | projectId, code, name, activeFrom/Until; unique (orgId, projectId, id)                                                                                                                                                                                                                                                                                                                              | S, I, U(activeUntil)                        |
| `CrewAssignment`                     | (orgId, projectId, crewId) FK → Crew; personId, role, validFrom/validUntil timestamptz; non-overlap trigger                                                                                                                                                                                                                                                                                         | S, I, U(validUntil) once                    |
| `ProjectSiteReference`               | projectId, n, lat/lon Decimal(9,6), radiusM 50–2000; unique (orgId, projectId, n)                                                                                                                                                                                                                                                                                                                   | S, I                                        |
| `FieldEntryCode`                     | projectId, code, retiredAt; one active per project; SELECT-only lookup policy on `app.entry_code`                                                                                                                                                                                                                                                                                                   | S, I, U(retiredAt)                          |
| `FieldDevice`                        | projectId, personId, state, tokenHash, prevTokenHash, generation, pendingUntil, confirm* and end* columns (CHECKs in §2), expiresAt, lastSeenAt, version; unique (orgId, projectId, id); partial unique (orgId, projectId, personId) WHERE CONFIRMED; SELECT-only lookup policy on `app.device_token_hash`                                                                                          | S, I, U(lifecycle columns), forward trigger |
| `FieldTokenHash`                     | hash PK, orgId, deviceId, acceptedAt                                                                                                                                                                                                                                                                                                                                                                | S, I                                        |
| `FieldConfirmChallenge`              | deviceId, deviceVersion, personId, projectId, codeHash, expiresAt, attempts, usedAt, supersededAt                                                                                                                                                                                                                                                                                                   | S, I, U(attempts, usedAt, supersededAt)     |
| `FieldDeviceEvent`                   | deviceId?, projectId, kind, reasonCode, distanceBucketM, at, actor; no coordinates                                                                                                                                                                                                                                                                                                                  | S, I                                        |
| `FieldDay`                           | (orgId, projectId, businessDate) unique, lastSeq                                                                                                                                                                                                                                                                                                                                                    | S, I, U(lastSeq)                            |
| `WorkerCheckIn`                      | projectId, personId, businessDate, siteTimezone, kind, (orgId, projectId, deviceId) FK, actorPersonId/AccountId/DeviceId, occurredAt, timePrecision, fixAt, deviceSentAt, receivedAt, recordedAt, clockSkewMs, lat/lon/accuracyM/distanceM (self only), siteRefN, actor fix, source, reason, flags, daySeq, voidedAt/By/Reason/voidSeq; partial unique slot; index (orgId, projectId, businessDate) | S, I, U(void columns) once                  |
| `FieldSelfie`, `CheckInSelfie`       | owner device, person and project; sha256; blobKey; expiresAt; deletedAt / (checkInId UNIQUE, selfieId UNIQUE)                                                                                                                                                                                                                                                                                       | S, I, U(deletedAt) once / S, I              |
| `ForemanReport`                      | (orgId, projectId, crewId) FK; businessDate; currentN; unique per (project, date, crew)                                                                                                                                                                                                                                                                                                             | S, I, U(currentN)                           |
| `ForemanReportRevision`              | reportId, n, rows jsonb, note, by person/device, occurredAt, receivedAt, siteTimezone, daySeq; unique (reportId, n)                                                                                                                                                                                                                                                                                 | S, I                                        |
| `ForemanAdoption`                    | projectId, businessDate, itemKey, value Decimal(20,6), basis jsonb, daySeq, byAccountId                                                                                                                                                                                                                                                                                                             | S, I                                        |
| `FieldThrottle`, `FieldThrottleSalt` | bucket, window, count / day, salt; no personal data; pruned after 48 h                                                                                                                                                                                                                                                                                                                              | S, I, U, D                                  |

`FOREMAN`/`WORKER` are not added to `Membership`, because Membership needs a LoginAccount.

## 8. Sequences

```text
A bind → challenge → confirm → check-in
 W: scan /field#e=CODE → POST entry → roster → pick self, token T → POST bind → PENDING
 W: POST checkin → 403 DEVICE_PENDING;  POST device/challenge → shows "Name · 482913"
 F: (with W) POST devices/confirm {personId, code 482913, expectedCurrentDeviceId:null}
    → person lock → rows → revoke old (none) → reject other PENDING → CONFIRMED
 W: POST checkin {key, event, deviceSentAt} → device share → T1–T5 → fence → day+slot lock → seq → 200
B revoked:  PM revoke (person lock, device FOR UPDATE) commits → W checkin → 401 DEVICE_ENDED
C retry:    key K commits, response lost → K again (fresh deviceSentAt, even 30 h later) → auth ok → same 200
            K with changed event → IDEMPOTENCY_KEY_REUSED; new key → ALREADY_CHECKED_IN
D proxy:    F POST checkin/proxy {personId, event with F's fix} → F foreman of W's crew now and at occurredAt → PROXY row
E adopt:    PM GET day (writer) → item COMPLETE 120, basis {crews [B,C], revs [B2,C1]}
            F(C) POST report expectedRevision 1 → C2 (day lock, seq)
            PM adopt with the old basis → FOREMAN_TOTAL_CHANGED → reload → adopt with [B2,C2] → facts.qty, ForemanAdoption
F submit:   check-in waiting on the day lock while submit holds it → gets seq > boundary → afterSubmission
```

## 9. Required negative tests (integration, isolated TEST DB, `mje_alpha_app`, via HTTP where a route exists)

| Class                   | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale overwrites newer  | Adopt with an old basis, a changed revision or a changed expected crew set. Foreman submit on n−1. `CONFIRM_STALE` after another phone was confirmed. PM confirm/revoke with an old `expectedVersion`. A concurrent rotate from two tabs. A check-in racing a revoke under controlled lock timing.                                                                                                                                                                                                                                                                                                                      |
| Unknown as exact        | Per-item statuses: `MISSING_REPORT`, `OMITTED`, blank, `UNKNOWN`, all-`NA`, explicit `0`, `OVERFLOW` → not adoptable. A PM proxy without a time is stored as `DAY` precision, never invented. A missing fix is never distance 0. NaN or out-of-range coordinates.                                                                                                                                                                                                                                                                                                                                                       |
| History rewritten       | UPDATE/DELETE on revisions, adoptions, events, site references, token hashes, `CheckInSelfie` and assignment history fails for the app role. Only the void and `validUntil` columns update, once. A REVOKED device never returns to CONFIRMED. A submitted snapshot is unchanged by later check-ins, voids, reports, roster or site-reference changes.                                                                                                                                                                                                                                                                  |
| Empty list skips checks | A foreman with no current crew, or an empty crew → `NOT_FOREMAN`. An empty expected crew set is not `COMPLETE`. An empty roster still validates the entry code. Unassignment revokes, and reassignment does not revive the device.                                                                                                                                                                                                                                                                                                                                                                                      |
| Unsanitised errors      | No response, log or audit row contains a token, hash, entry code, challenge, coordinates, selfie key or another person's name. Wrong-org and unknown tokens get identical 401s. A cross-project `:id` gets the same 404 as a nonexistent one.                                                                                                                                                                                                                                                                                                                                                                           |
| Device and auth         | Competing binds for one person: only the browser whose challenge is typed gets confirmed. Challenge expiry, reuse, wrong version and 5 bad attempts. Self-confirm through a second account. Bind retry with the same token → one row; the same token with another person → `TOKEN_CONFLICT`. Rotation lost response, second rotation with the previous hash, previous hash on an ordinary route, a reused hash, revoke vs rotate. Bootstrap under the low-privilege role and pooled-connection context isolation. PENDING device on privileged routes. Throttle 429s, and a shared IP onboarding 40 people without 429. |
| Time                    | Retries at 6 min and 25 h after a commit (replay OK). A first attempt at 25 h → `TOO_LATE`. A future fix, a stale fix, `occurredAt > deviceSentAt`, skew of ±6 min. 23:59/00:00 local and DST transitions; a client date ≠ server-derived date. `siteTimezone` persisted.                                                                                                                                                                                                                                                                                                                                               |
| Authority               | Cross-crew proxy; a proxy from a worker device. A foreman replaced at noon: A is refused at 12:01, B is allowed. Overlapping assignment inserts, concurrently. A backdated assignment is refused. A report for two days ago by a foreman → refused.                                                                                                                                                                                                                                                                                                                                                                     |
| PM proxy                | 7-day window. An off-site fix → `REMOTE_PROXY`. No fix → `PROXY_LOCATION_UNAVAILABLE`. A coarse fix. The actor fix is never stored as the worker's location.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Ordering                | A check-in, void, foreman revision or adoption interleaved with submit, under controlled lock timing: each row is either ≤ boundary and in the revision, or > boundary and `afterSubmission`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Selfie                  | Someone else's staged selfie, an expired one, one already attached, attaching after the check-in, feature off, retention deletion keeping `hasSelfie`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Executive reader (A6.0) | `GET day`/`days`/`revision` over HTTP before submit, after submit and during a correction: no live facts, foreman data or check-ins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 10. Open questions

The user decided the earlier Q1–Q8 (§0). Two defaults remain for the user to confirm:

1. Selfie retention once enabled. **Default: 30 days, then delete the image and keep `hasSelfie`.**
2. How far back a PM proxy may go. **Default: 7 days, reason required when the date is not today.**

PR plan: A6.0 reader filter (OD18) → A6a roster, devices and entry → A6b check-in and selfie → A6c foreman reports and adopt → A6d web.

/**
 * Field devices and entry (A6a; design docs/architecture/a6-field-devices-design.md §1, §2,
 * §5, §6). A FieldDevice proves only that a PM or the crew foreman confirmed, face to face, the
 * browser showing a challenge; it proves nothing about identity, presence or who holds the
 * phone. Authority is recomputed per request from the CrewAssignment rows that contain now.
 * Device routes authenticate with the token hash (never the token) through `fieldTransaction`;
 * PM routes are Entra PROJECT_MANAGER writes through `inTransaction`.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { encodeDeviceCursor } from '@mje/contracts';
import type {
  BindCommand,
  ChallengeConfirmCommand,
  ChallengeDto,
  CreateCrewCommand,
  DeviceDecisionDto,
  DeviceListQuery,
  EndCrewCommand,
  EntryCommand,
  EntryDto,
  FieldDeviceDto,
  FieldDeviceListDto,
  FieldMeDto,
  PmConfirmCommand,
  PmDeviceCommand,
  ReleaseCommand,
  RosterChangesCommand,
  RosterDto,
  RotateCommand,
  RotateEntryCodeCommand,
  RotateResultDto,
} from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import {
  CHALLENGE_MS,
  LIFETIME_MS,
  MAX_FAILED_MATCHES,
  MAX_PENDING_PER_PERSON,
  PENDING_MS,
  effectiveState,
  expiryReason,
  isLive,
} from './field-rules.js';
import {
  DEVICE_COLUMNS,
  FieldError,
  FieldThrottle,
  decisionTime,
  LIMITS,
  deviceEvent,
  endDevice,
  fieldIdempotent,
  fieldTransaction,
  hashSecret,
  keyLock,
  personLocks,
  settled,
  tokenLock,
  type DeviceRow,
  type EventActor,
  type Limit,
  type Outcome,
} from './field-kit.js';
import {
  NOW_IN,
  changeRoster,
  createCrew,
  endCrew,
  readRoster,
} from './field-roster.js';
import {
  audit,
  inTransaction,
  projectWriter,
  type Actor,
} from './store-kit.js';

export interface FieldStoreOptions {
  /** TEST seam: the 6-digit challenge generator (default: crypto randomInt). */
  challengeCode?: () => string;
  /** TEST seam, read per request: false switches deferred housekeeping off. */
  housekeeping?: boolean;
}
const codeHash = (orgId: string, personId: string, code: string) =>
  hashSecret(`${orgId}:${personId}:${code}`);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class FieldStore {
  readonly throttle: FieldThrottle;
  constructor(
    private readonly pool: Pool,
    private readonly options: FieldStoreOptions = {},
  ) {
    this.throttle = new FieldThrottle(pool);
  }
  private get deferred() {
    return this.options.housekeeping !== false;
  }

  // ---------- entry code: roster read and bind ----------
  /** A transaction in the org of an active entry code, found through its lookup policy. */
  private async entryTransaction<T>(
    code: string,
    work: (client: PoolClient, orgId: string, projectId: string) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SELECT set_config('app.entry_code', $1, true)", [
        code,
      ]);
      const r = await client.query<{ orgId: string; projectId: string }>(
        `SELECT "orgId", "projectId" FROM "FieldEntryCode" WHERE "retiredAt" IS NULL AND code=$1`,
        [code],
      );
      const entry = r.rows[0];
      if (!entry) throw new FieldError('ENTRY_CODE_INVALID');
      await client.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.entry_code', '', true)",
        [entry.orgId],
      );
      const result = await work(client, entry.orgId, entry.projectId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  /** U7: anyone holding the code sees the current members' display names. */
  async entry(ip: string, cmd: EntryCommand): Promise<EntryDto> {
    await this.throttle.hit([LIMITS.entryIp(ip), LIMITS.entryCode(cmd.code)]);
    return this.entryTransaction(cmd.code, async (client, orgId, projectId) => {
      const project = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM "Project" WHERE "orgId"=$1 AND id=$2`,
        [orgId, projectId],
      );
      const roster = await client.query<EntryDto['roster'][number]>(
        `SELECT a."personId", p."displayName", c.name AS "crewName"
        FROM "CrewAssignment" a JOIN "Person" p ON p."orgId"=a."orgId" AND p.id=a."personId"
          JOIN "Crew" c ON c."orgId"=a."orgId" AND c.id=a."crewId"
        WHERE a."orgId"=$1 AND a."projectId"=$2 AND a.role='MEMBER' AND ${NOW_IN('a')}
        ORDER BY p."displayName", a."personId"`,
        [orgId, projectId],
      );
      return { project: project.rows[0]!, roster: roster.rows };
    });
  }
  async bind(ip: string, cmd: BindCommand) {
    await this.throttle.hit([LIMITS.bindIp(ip), LIMITS.bindCode(cmd.code)]);
    const hash = hashSecret(cmd.token);
    return this.entryTransaction(cmd.code, async (client, orgId, projectId) => {
      // Level I: one bind or rotation per token hash; then any device holding it, in any org.
      await tokenLock(client, hash);
      await client.query(
        "SELECT set_config('app.device_token_hash', $1, true)",
        [hash],
      );
      const prior = await client.query<{
        id: string;
        orgId: string;
        projectId: string;
        personId: string;
        current: boolean;
      }>(
        `SELECT id, "orgId", "projectId", "personId", "tokenHash"=$1 AS current FROM "FieldDevice"
        WHERE "tokenHash"=$1 OR "prevTokenHash"=$1`,
        [hash],
      );
      await client.query(
        "SELECT set_config('app.device_token_hash', '', true)",
      );
      const p = prior.rows[0];
      if (p) {
        if (
          p.current &&
          p.orgId === orgId &&
          p.projectId === projectId &&
          p.personId === cmd.personId
        )
          return this.bindView(client, orgId, p.id);
        throw new FieldError('TOKEN_CONFLICT');
      }
      await personLocks(client, orgId, projectId, [cmd.personId]);
      // Design §5: the decision time, once the person lock is held.
      const { at } = await decisionTime(client, orgId, projectId);
      const run = await client.query<{ member: boolean }>(
        `SELECT member FROM field_member_run($1,$2,$3,$4::timestamptz)`,
        [orgId, projectId, cmd.personId, at],
      );
      if (!run.rows[0]!.member) throw new FieldError('PERSON_NOT_ROSTERED');
      const pending = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "FieldDevice" WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3
          AND state='PENDING' AND "pendingUntil" > $4::timestamptz AND "expiresAt" > $4::timestamptz
          AND ("memberUntil" IS NULL OR "memberUntil" > $4::timestamptz)`,
        [orgId, projectId, cmd.personId, at],
      );
      // Only pending devices that are still live by every deadline hold a slot; one whose
      // membership ended is already refused by its timestamps even while stored PENDING.
      if (pending.rows[0]!.n >= MAX_PENDING_PER_PERSON)
        throw new FieldError('TOO_MANY_PENDING');
      const id = randomUUID();
      await client.query(
        `INSERT INTO "FieldDevice"(id,"orgId","projectId","personId",state,"tokenHash","pendingUntil","expiresAt","memberUntil","lastSeenAt")
        SELECT $1,$2,$3,$4,'PENDING',$5, $8::timestamptz + $6 * interval '1 millisecond', $8::timestamptz + $7 * interval '1 millisecond', r."until", $8::timestamptz
        FROM field_member_run($2,$3,$4,$8::timestamptz) r`,
        [id, orgId, projectId, cmd.personId, hash, PENDING_MS, LIFETIME_MS, at],
      );
      // Every accepted hash is registered once; a hash seen before (even a cleared previous
      // one) is a conflict, and the device insert rolls back with it.
      const registered = await client.query(
        `INSERT INTO "FieldTokenHash"(hash,"orgId","deviceId") VALUES($1,$2,$3) ON CONFLICT (hash) DO NOTHING`,
        [hash, orgId, id],
      );
      if (!registered.rowCount) throw new FieldError('TOKEN_CONFLICT');
      await deviceEvent(client, {
        orgId,
        projectId,
        deviceId: id,
        personId: cmd.personId,
        kind: 'BIND',
        actor: { deviceId: id, personId: cmd.personId },
      });
      return this.bindView(client, orgId, id);
    });
  }
  private async bindView(client: PoolClient, orgId: string, id: string) {
    const r = await client.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM "FieldDevice" d WHERE d."orgId"=$1 AND d.id=$2`,
      [orgId, id],
    );
    const d = r.rows[0]!;
    return {
      deviceId: d.id,
      state: d.state,
      generation: d.generation,
      pendingUntil: d.pendingUntil.toISOString(),
    };
  }

  // ---------- device routes ----------
  async me(ip: string, tokenHash: string): Promise<FieldMeDto> {
    return fieldTransaction(
      this.pool,
      this.throttle,
      tokenHash,
      ip,
      {
        deferred: this.deferred,
        allowPending: true,
      },
      async (client, { device: d }) => {
        const info = await client.query<{
          displayName: string;
          name: string;
          timezone: string;
        }>(
          `SELECT p."displayName", pr.name, pr.timezone FROM "Person" p, "Project" pr
          WHERE p."orgId"=$1 AND p.id=$2 AND pr."orgId"=$1 AND pr.id=$3`,
          [d.orgId, d.personId, d.projectId],
        );
        const crew = await this.crewNow(client, d, 'MEMBER');
        const foremanOf =
          d.state === 'CONFIRMED'
            ? await this.crewNow(client, d, 'FOREMAN')
            : null;
        let foreman: FieldMeDto['foreman'] = null;
        if (foremanOf) {
          const members = await client.query<
            NonNullable<FieldMeDto['foreman']>['members'][number]
          >(
            `SELECT a."personId", p."displayName",
              (SELECT x.id FROM "FieldDevice" x WHERE x."orgId"=a."orgId" AND x."projectId"=a."projectId" AND x."personId"=a."personId"
                AND x.state='CONFIRMED' AND x."expiresAt" > now() AND (x."memberUntil" IS NULL OR x."memberUntil" > now())
                AND x."lastSeenAt" + interval '30 days' > now()) AS "currentDeviceId",
              (SELECT count(*) FROM "FieldDevice" x WHERE x."orgId"=a."orgId" AND x."projectId"=a."projectId" AND x."personId"=a."personId"
                AND x.state='PENDING' AND x."pendingUntil" > now() AND x."expiresAt" > now()
                AND (x."memberUntil" IS NULL OR x."memberUntil" > now()))::int AS "pendingDevices"
            FROM "CrewAssignment" a JOIN "Person" p ON p."orgId"=a."orgId" AND p.id=a."personId"
            WHERE a."orgId"=$1 AND a."crewId"=$2 AND a.role='MEMBER' AND ${NOW_IN('a')}
            ORDER BY p."displayName", a."personId"`,
            [d.orgId, foremanOf.id],
          );
          foreman = {
            crewId: foremanOf.id,
            crewName: foremanOf.name,
            members: members.rows,
          };
        }
        const i = info.rows[0]!;
        return {
          device: {
            deviceId: d.id,
            state: d.state,
            generation: d.generation,
            pendingUntil:
              d.state === 'PENDING' ? d.pendingUntil.toISOString() : null,
            expiresAt: d.expiresAt.toISOString(),
            memberUntil: iso(d.memberUntil),
            tokenIssuedAt: (d.rotatedAt ?? d.createdAt).toISOString(),
          },
          person: { id: d.personId, displayName: i.displayName },
          project: { id: d.projectId, name: i.name, timezone: i.timezone },
          crew,
          foreman,
        };
      },
    );
  }
  private async crewNow(
    client: PoolClient,
    d: { orgId: string; projectId: string; personId: string },
    role: 'MEMBER' | 'FOREMAN',
  ): Promise<{ id: string; name: string } | null> {
    const r = await client.query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM "CrewAssignment" a JOIN "Crew" c ON c."orgId"=a."orgId" AND c.id=a."crewId"
      WHERE a."orgId"=$1 AND a."projectId"=$2 AND a."personId"=$3 AND a.role=$4 AND ${NOW_IN('a')}`,
      [d.orgId, d.projectId, d.personId, role],
    );
    return r.rows[0] ?? null;
  }

  /** A new 6-digit code for the pending browser to show; its previous one is superseded. */
  async challenge(ip: string, tokenHash: string): Promise<ChallengeDto> {
    // The IP gate first; the per-device bucket exists only for a real pending device.
    if (await this.throttle.full(LIMITS.unknownToken(ip)))
      throw new FieldError('RATE_LIMITED');
    await this.throttle.hit([LIMITS.challenge(tokenHash)]);
    return fieldTransaction(
      this.pool,
      this.throttle,
      tokenHash,
      ip,
      {
        deferred: this.deferred,
        allowPending: true,
        persons: (d) => [d.personId],
      },
      async (client, { device: d, at }) => {
        if (d.state !== 'PENDING') throw new FieldError('FORBIDDEN');
        await client.query(
          `UPDATE "FieldConfirmChallenge" SET "supersededAt"=now()
          WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 AND "usedAt" IS NULL AND "supersededAt" IS NULL
            AND ("deviceId"=$4 OR "expiresAt" <= $5::timestamptz)`,
          [d.orgId, d.projectId, d.personId, d.id, at],
        );
        const live = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "FieldConfirmChallenge"
          WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 AND "usedAt" IS NULL AND "supersededAt" IS NULL`,
          [d.orgId, d.projectId, d.personId],
        );
        // The failure counter covers the person's live challenges; with none left it starts over.
        if (live.rows[0]!.n === 0) await this.resetFailures(client, d);
        // Draw again while the code equals another live code of the same person.
        const draw = async (): Promise<string> => {
          for (let attempt = 0; attempt < 20; attempt++) {
            const code =
              this.options.challengeCode?.() ??
              String(randomInt(0, 1_000_000)).padStart(6, '0');
            const clash = await client.query(
              `SELECT 1 FROM "FieldConfirmChallenge" WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3
                AND "codeHash"=$4 AND "usedAt" IS NULL AND "supersededAt" IS NULL`,
              [
                d.orgId,
                d.projectId,
                d.personId,
                codeHash(d.orgId, d.personId, code),
              ],
            );
            if (!clash.rowCount) return code;
          }
          throw new FieldError('RETRY');
        };
        const code = await draw();
        const r = await client.query<{ expiresAt: Date }>(
          `INSERT INTO "FieldConfirmChallenge"(id,"orgId","projectId","personId","deviceId","deviceVersion","codeHash","expiresAt")
          VALUES($1,$2,$3,$4,$5,$6,$7, LEAST($10::timestamptz + $8 * interval '1 millisecond', $9::timestamptz)) RETURNING "expiresAt"`,
          [
            randomUUID(),
            d.orgId,
            d.projectId,
            d.personId,
            d.id,
            d.version,
            codeHash(d.orgId, d.personId, code),
            CHALLENGE_MS,
            d.pendingUntil,
            at,
          ],
        );
        await deviceEvent(client, {
          orgId: d.orgId,
          projectId: d.projectId,
          deviceId: d.id,
          personId: d.personId,
          kind: 'CHALLENGE',
          actor: { deviceId: d.id, personId: d.personId },
        });
        return { code, expiresAt: r.rows[0]!.expiresAt.toISOString() };
      },
    );
  }
  private async resetFailures(
    client: PoolClient,
    d: { orgId: string; projectId: string; personId: string },
  ) {
    await client.query(
      `INSERT INTO "FieldPersonConfirm"(id,"orgId","projectId","personId",failures,"windowStart") VALUES($1,$2,$3,$4,0,now())
      ON CONFLICT ("orgId","projectId","personId") DO UPDATE SET failures=0, "windowStart"=now()`,
      [randomUUID(), d.orgId, d.projectId, d.personId],
    );
  }

  async release(ip: string, tokenHash: string, cmd: ReleaseCommand) {
    const route = 'FIELD_RELEASE';
    return fieldTransaction(
      this.pool,
      this.throttle,
      tokenHash,
      ip,
      {
        deferred: this.deferred,
        lifecycle: true,
        allowPending: true,
        keyLock: { route, key: cmd.clientMutationId },
        persons: (d) => [d.personId],
      },
      async (client, { device: d }) =>
        settled(
          await fieldIdempotent(
            client,
            d.orgId,
            d.id,
            route,
            cmd.clientMutationId,
            cmd,
            async () => {
              const state = d.state === 'CONFIRMED' ? 'REVOKED' : 'REJECTED';
              await endDevice(client, d, state, 'RELEASED', {
                deviceId: d.id,
                personId: d.personId,
              });
              return { status: 200, body: { deviceId: d.id, state } };
            },
          ),
        ),
    );
  }

  /**
   * Rotation (§2): the current token O with generation g becomes the previous hash, N the
   * current one. The exact replay of that rotation with O is the only use of O afterwards.
   */
  async rotate(
    ip: string,
    tokenHash: string,
    cmd: RotateCommand,
  ): Promise<RotateResultDto> {
    const next = hashSecret(cmd.newToken);
    return fieldTransaction(
      this.pool,
      this.throttle,
      tokenHash,
      ip,
      {
        deferred: this.deferred,
        lifecycle: true,
        allowPrevious: true,
        tokenLock: next,
        persons: (d) => [d.personId],
      },
      async (client, { device: d, matched }) => {
        if (matched === 'previous') {
          const same = await client.query<{ ok: boolean }>(
            `SELECT "tokenHash"=$3 AND generation=$4 AS ok FROM "FieldDevice" WHERE "orgId"=$1 AND id=$2`,
            [d.orgId, d.id, next, cmd.expectedGeneration + 1],
          );
          if (!same.rows[0]!.ok) throw new FieldError('FIELD_AUTH_REQUIRED');
          return { generation: d.generation };
        }
        if (d.generation !== cmd.expectedGeneration)
          throw new FieldError('VERSION_CONFLICT');
        if (next === tokenHash) throw new FieldError('TOKEN_CONFLICT');
        const registered = await client.query(
          `INSERT INTO "FieldTokenHash"(hash,"orgId","deviceId") VALUES($1,$2,$3) ON CONFLICT (hash) DO NOTHING`,
          [next, d.orgId, d.id],
        );
        if (!registered.rowCount) throw new FieldError('TOKEN_CONFLICT');
        await client.query(
          `UPDATE "FieldDevice" SET "prevTokenHash"="tokenHash", "tokenHash"=$3, generation=generation+1, "rotatedAt"=now()
          WHERE "orgId"=$1 AND id=$2`,
          [d.orgId, d.id, next],
        );
        await deviceEvent(client, {
          orgId: d.orgId,
          projectId: d.projectId,
          deviceId: d.id,
          personId: d.personId,
          kind: 'ROTATE',
          actor: { deviceId: d.id, personId: d.personId },
        });
        return { generation: d.generation + 1 };
      },
    );
  }

  // ---------- confirmation by challenge (foreman device or PM) ----------
  async confirm(ip: string, tokenHash: string, cmd: ChallengeConfirmCommand) {
    return this.foremanDecision(ip, tokenHash, cmd, 'confirm');
  }
  async reject(
    ip: string,
    tokenHash: string,
    cmd: Omit<ChallengeConfirmCommand, 'expectedCurrentDeviceId'>,
  ) {
    return this.foremanDecision(
      ip,
      tokenHash,
      { ...cmd, expectedCurrentDeviceId: null },
      'reject',
    );
  }
  private async foremanDecision(
    ip: string,
    tokenHash: string,
    cmd: ChallengeConfirmCommand,
    kind: 'confirm' | 'reject',
  ): Promise<DeviceDecisionDto> {
    const route = kind === 'confirm' ? 'FIELD_CONFIRM' : 'FIELD_REJECT';
    let actorId = '';
    const outcome = await fieldTransaction(
      this.pool,
      this.throttle,
      tokenHash,
      ip,
      {
        deferred: this.deferred,
        keyLock: { route, key: cmd.clientMutationId },
        persons: (d) => [d.personId, cmd.personId],
        afterLock: (client, d) =>
          this.lockSubject(client, d.orgId, d.projectId, cmd.personId),
      },
      async (client, { device: d, now, at }) => {
        actorId = d.id;
        if (d.personId === cmd.personId) throw new FieldError('SELF_CONFIRM');
        // U4: only the foreman of the subject's current crew, with authority now.
        const crew = await this.crewNow(client, d, 'FOREMAN');
        if (!crew) throw new FieldError('NOT_FOREMAN');
        await this.assertInProject(client, d.orgId, d.projectId, cmd.personId);
        const member = await client.query(
          `SELECT 1 FROM "CrewAssignment" a WHERE a."orgId"=$1 AND a."crewId"=$2 AND a."personId"=$3
            AND a.role='MEMBER' AND ${NOW_IN('a')}`,
          [d.orgId, crew.id, cmd.personId],
        );
        if (!member.rowCount) throw new FieldError('NOT_FOREMAN');
        if (await this.throttle.full(LIMITS.failedConfirms(d.id), client))
          throw new FieldError('RATE_LIMITED');
        return fieldIdempotent(
          client,
          d.orgId,
          d.id,
          route,
          cmd.clientMutationId,
          cmd,
          () =>
            this.decide(
              client,
              d.orgId,
              d.projectId,
              cmd,
              kind,
              { deviceId: d.id, personId: d.personId },
              { t: now, at },
            ),
        );
      },
    );
    return this.settleDecision(outcome, LIMITS.failedConfirms(actorId));
  }
  /** The PM confirms face to face with the same challenge; SELF_CONFIRM covers every account of the person. */
  async pmConfirm(
    identity: Identity,
    cmd: PmConfirmCommand,
  ): Promise<DeviceDecisionDto> {
    const route = 'FIELD_PM_CONFIRM';
    let actorId = '';
    const outcome = await inTransaction(
      this.pool,
      identity,
      async (client, actor) => {
        actorId = actor.accountId;
        await projectWriter(client, actor, cmd.projectId);
        if (actor.personId === cmd.personId)
          throw new FieldError('SELF_CONFIRM');
        await this.assertInProject(
          client,
          actor.orgId,
          cmd.projectId,
          cmd.personId,
        );
        await keyLock(
          client,
          actor.orgId,
          actor.accountId,
          route,
          cmd.clientMutationId,
        );
        await personLocks(client, actor.orgId, cmd.projectId, [
          actor.personId,
          cmd.personId,
        ]);
        if (
          await this.throttle.full(
            LIMITS.failedConfirms(actor.accountId),
            client,
          )
        )
          throw new FieldError('RATE_LIMITED');
        return fieldIdempotent(
          client,
          actor.orgId,
          actor.accountId,
          route,
          cmd.clientMutationId,
          cmd,
          () =>
            this.decide(client, actor.orgId, cmd.projectId, cmd, 'confirm', {
              accountId: actor.accountId,
              personId: actor.personId,
            }),
        );
      },
    );
    return this.settleDecision(outcome, LIMITS.failedConfirms(actorId));
  }
  private async settleDecision(
    o: Outcome<DeviceDecisionDto> & { replayed: boolean },
    limit: Limit,
  ): Promise<DeviceDecisionDto> {
    // A newly committed failed match also counts against the confirmer (not on a replay).
    if (o.status !== 200 && !o.replayed)
      await this.throttle.add(limit).catch(() => undefined);
    return settled(o);
  }
  /** A target person outside the project (never rostered there, other org, none) is NOT_FOUND. */
  private async assertInProject(
    client: PoolClient,
    orgId: string,
    projectId: string,
    personId: string,
  ) {
    const r = await client.query(
      `SELECT 1 FROM "CrewAssignment" WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 LIMIT 1`,
      [orgId, projectId, personId],
    );
    if (!r.rowCount) throw new FieldError('NOT_FOUND');
  }
  /**
   * The challenge ceremony, under the actor and subject person locks: the subject's live
   * devices FOR UPDATE (level 2, id order), then the challenge rows and the counter (2c). A
   * wrong code identifies no challenge and is counted per person; it is a committed result,
   * not a throw. On success: stale check, revoke the current device (REPLACED) before
   * confirming, reject every other pending device (SUPERSEDED), confirm and burn the code.
   */
  /** The subject's live devices FOR UPDATE (level 2, id order), then its live challenges (2c). */
  private async lockSubject(
    client: PoolClient,
    orgId: string,
    projectId: string,
    personId: string,
  ): Promise<DeviceRow[]> {
    const devices = await client.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM "FieldDevice" d
      WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."personId"=$3 AND d.state IN ('PENDING','CONFIRMED')
      ORDER BY d.id FOR UPDATE`,
      [orgId, projectId, personId],
    );
    await client.query(
      `SELECT id FROM "FieldConfirmChallenge" WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3
        AND "usedAt" IS NULL AND "supersededAt" IS NULL ORDER BY id FOR UPDATE`,
      [orgId, projectId, personId],
    );
    return devices.rows;
  }
  private async decide(
    client: PoolClient,
    orgId: string,
    projectId: string,
    cmd: ChallengeConfirmCommand,
    kind: 'confirm' | 'reject',
    actor: EventActor,
    decided: { t: Date; at: string } | null = null,
  ): Promise<Outcome<DeviceDecisionDto>> {
    const personId = cmd.personId;
    // Levels 2 and 2c (re-entrant when the foreman path took them before its decision time),
    // then one decision time for every deadline below (design §5).
    const devices = await this.lockSubject(client, orgId, projectId, personId);
    const { t, at } = decided ?? (await decisionTime(client, orgId, projectId));
    const match = await client.query<{ id: string; deviceId: string }>(
      `SELECT c.id, c."deviceId" FROM "FieldConfirmChallenge" c
        JOIN "FieldDevice" d ON d."orgId"=c."orgId" AND d.id=c."deviceId"
      WHERE c."orgId"=$1 AND c."projectId"=$2 AND c."personId"=$3 AND c."codeHash"=$4
        AND c."usedAt" IS NULL AND c."supersededAt" IS NULL AND c."expiresAt" > $5::timestamptz
        AND d.state='PENDING' AND d.version=c."deviceVersion"`,
      [orgId, projectId, personId, codeHash(orgId, personId, cmd.code), at],
    );
    const m = match.rows[0];
    const target = m
      ? devices.find((x) => x.id === m.deviceId && !expiryReason(x, t))
      : undefined;
    const subject = { orgId, projectId, personId };
    if (!m || !target) {
      const counter = await client.query<{ failures: number }>(
        `INSERT INTO "FieldPersonConfirm"(id,"orgId","projectId","personId",failures,"windowStart") VALUES($1,$2,$3,$4,1,now())
        ON CONFLICT ("orgId","projectId","personId") DO UPDATE SET failures="FieldPersonConfirm".failures+1
        RETURNING failures`,
        [randomUUID(), orgId, projectId, personId],
      );
      await deviceEvent(client, {
        ...subject,
        kind: 'CHALLENGE_FAILED',
        reason: 'CHALLENGE_INVALID',
        actor,
      });
      if (counter.rows[0]!.failures >= MAX_FAILED_MATCHES) {
        await client.query(
          `UPDATE "FieldConfirmChallenge" SET "supersededAt"=now()
          WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 AND "usedAt" IS NULL AND "supersededAt" IS NULL`,
          [orgId, projectId, personId],
        );
        await this.resetFailures(client, subject);
        await deviceEvent(client, {
          ...subject,
          kind: 'CHALLENGES_RESET',
          actor,
        });
      }
      return { status: 409, body: { code: 'CHALLENGE_INVALID' } };
    }
    await client.query(
      `UPDATE "FieldConfirmChallenge" SET "usedAt"=now() WHERE "orgId"=$1 AND id=$2`,
      [orgId, m.id],
    );
    if (kind === 'reject') {
      await endDevice(client, target, 'REJECTED', 'REJECTED', actor);
    } else {
      let current = devices.find((x) => x.state === 'CONFIRMED');
      const lapsed = current ? expiryReason(current, t) : null;
      if (current && lapsed) {
        await endDevice(client, current, 'EXPIRED', lapsed, {}, at);
        current = undefined;
      }
      // The confirmer's view was old: another phone was confirmed or revoked meanwhile.
      if ((current?.id ?? null) !== cmd.expectedCurrentDeviceId)
        throw new FieldError('CONFIRM_STALE');
      if (current)
        await endDevice(client, current, 'REVOKED', 'REPLACED', actor);
      for (const other of devices)
        if (other.state === 'PENDING' && other.id !== target.id)
          await endDevice(client, other, 'REJECTED', 'SUPERSEDED', actor);
      await client.query(
        `UPDATE "FieldDevice" SET state='CONFIRMED', "confirmedAt"=$6::timestamptz, "confirmedByPersonId"=$3,
          "confirmedByAccountId"=$4, "confirmedByDeviceId"=$5, version=version+1, "lastSeenAt"=GREATEST("lastSeenAt", $6::timestamptz)
        WHERE "orgId"=$1 AND id=$2 AND state='PENDING'`,
        [
          orgId,
          target.id,
          actor.personId,
          actor.accountId ?? null,
          actor.deviceId ?? null,
          at,
        ],
      );
      await deviceEvent(client, {
        ...subject,
        deviceId: target.id,
        kind: 'CONFIRM',
        reason: actor.deviceId ? 'FOREMAN' : 'PM',
        actor,
      });
    }
    await client.query(
      `UPDATE "FieldConfirmChallenge" SET "supersededAt"=now()
      WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 AND "usedAt" IS NULL AND "supersededAt" IS NULL
        AND ("deviceId"=$4 OR $5)`,
      [orgId, projectId, personId, target.id, kind === 'confirm'],
    );
    await this.resetFailures(client, subject);
    return {
      status: 200,
      body: {
        deviceId: target.id,
        personId,
        state: kind === 'confirm' ? 'CONFIRMED' : 'REJECTED',
      },
    };
  }

  // ---------- project manager ----------
  private pm<T>(
    identity: Identity,
    projectId: string,
    work: (client: PoolClient, actor: Actor) => Promise<T>,
  ): Promise<T> {
    return inTransaction(this.pool, identity, async (client, actor) => {
      await projectWriter(client, actor, projectId);
      return work(client, actor);
    });
  }
  /**
   * A roster write: idempotent per key; the stored replay holds only the roster version (no
   * names), and the response is the roster as it is after the write.
   */
  private rosterWrite(
    identity: Identity,
    projectId: string,
    route: string,
    cmd: { clientMutationId: string },
    work: (client: PoolClient, actor: Actor) => Promise<number>,
  ): Promise<RosterDto> {
    return this.pm(identity, projectId, async (client, actor) => {
      settled(
        await fieldIdempotent(
          client,
          actor.orgId,
          actor.accountId,
          route,
          cmd.clientMutationId,
          cmd,
          async () => ({
            status: 200,
            body: { rosterVersion: await work(client, actor) },
          }),
        ),
      );
      return readRoster(client, actor.orgId, projectId);
    });
  }
  /**
   * One page of the project's devices, newest first (keyset on exact creation time and id), so
   * every device, however old, is reachable by following `nextCursor`.
   */
  async devices(
    identity: Identity,
    query: DeviceListQuery,
  ): Promise<FieldDeviceListDto> {
    const { projectId, after, limit } = query;
    return this.pm(identity, projectId, async (client, actor) => {
      const r = await client.query<
        DeviceRow & {
          now: Date;
          displayName: string;
          endReason: string | null;
          confirmedAt: Date | null;
          confirmedByPersonId: string | null;
          confirmedByDeviceId: string | null;
          createdAtKey: string;
        }
      >(
        `SELECT ${DEVICE_COLUMNS}, now() AS now, p."displayName", d."endReason", d."confirmedAt",
          d."confirmedByPersonId", d."confirmedByDeviceId",
          to_char(d."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtKey"
        FROM "FieldDevice" d JOIN "Person" p ON p."orgId"=d."orgId" AND p.id=d."personId"
        WHERE d."orgId"=$1 AND d."projectId"=$2
          AND ($3::timestamptz IS NULL OR (d."createdAt", d.id) < ($3::timestamptz, $4::uuid))
        ORDER BY d."createdAt" DESC, d.id DESC LIMIT $5`,
        [
          actor.orgId,
          projectId,
          after?.createdAt ?? null,
          after?.id ?? null,
          limit + 1,
        ],
      );
      const page = r.rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        r.rows.length > limit && last
          ? encodeDeviceCursor(last.createdAtKey, last.id)
          : null;
      const devices = page.map((d): FieldDeviceDto => ({
        id: d.id,
        personId: d.personId,
        displayName: d.displayName,
        state: d.state,
        effectiveState: effectiveState(d, d.now),
        endReason: d.endReason,
        version: d.version,
        createdAt: d.createdAt.toISOString(),
        confirmedAt: iso(d.confirmedAt),
        confirmedBy: d.confirmedByPersonId
          ? {
              kind: d.confirmedByDeviceId ? 'FOREMAN' : 'PM',
              personId: d.confirmedByPersonId,
            }
          : null,
        lastSeenAt: d.lastSeenAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
        memberUntil: iso(d.memberUntil),
      }));
      return { devices, nextCursor };
    });
  }
  /** Revoke (CONFIRMED → REVOKED, PENDING → REJECTED) or reject (PENDING) one device row. */
  async pmDevice(
    identity: Identity,
    cmd: PmDeviceCommand,
    action: 'revoke' | 'reject',
  ) {
    const route = action === 'revoke' ? 'FIELD_PM_REVOKE' : 'FIELD_PM_REJECT';
    return this.pm(identity, cmd.projectId, async (client, actor) => {
      const seen = await client.query<{ personId: string }>(
        `SELECT "personId" FROM "FieldDevice" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3`,
        [actor.orgId, cmd.projectId, cmd.deviceId],
      );
      if (!seen.rows[0]) throw new FieldError('NOT_FOUND');
      await keyLock(
        client,
        actor.orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
      );
      await personLocks(client, actor.orgId, cmd.projectId, [
        seen.rows[0].personId,
      ]);
      const o = await fieldIdempotent(
        client,
        actor.orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
        cmd,
        async () => {
          const r = await client.query<DeviceRow>(
            `SELECT ${DEVICE_COLUMNS} FROM "FieldDevice" d WHERE d."orgId"=$1 AND d.id=$2 FOR UPDATE`,
            [actor.orgId, cmd.deviceId],
          );
          const d = r.rows[0]!;
          if (
            d.version !== cmd.expectedVersion ||
            !isLive(d.state) ||
            (action === 'reject' && d.state !== 'PENDING')
          )
            throw new FieldError('VERSION_CONFLICT');
          const state = d.state === 'CONFIRMED' ? 'REVOKED' : 'REJECTED';
          await endDevice(
            client,
            d,
            state,
            action === 'revoke' ? 'REVOKED' : 'REJECTED',
            {
              accountId: actor.accountId,
              personId: actor.personId,
            },
          );
          await audit(
            client,
            actor,
            { type: 'FIELD_DEVICE', id: d.id, version: d.version + 1 },
            route,
            '',
            { state: d.state },
            { state },
            cmd.clientMutationId,
          );
          return {
            status: 200,
            body: { deviceId: d.id, state, version: d.version + 1 },
          };
        },
      );
      return settled(o);
    });
  }
  /** A new 128-bit entry code; the previous one stops working. The code is never audited. */
  async rotateEntryCode(identity: Identity, cmd: RotateEntryCodeCommand) {
    return this.pm(identity, cmd.projectId, async (client, actor) => {
      const o = await fieldIdempotent(
        client,
        actor.orgId,
        actor.accountId,
        'FIELD_ENTRY_ROTATE',
        cmd.clientMutationId,
        cmd,
        async () => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`${actor.orgId}:field-entry:${cmd.projectId}`],
          );
          await client.query(
            `UPDATE "FieldEntryCode" SET "retiredAt"=now(), "retiredBy"=$3
            WHERE "orgId"=$1 AND "projectId"=$2 AND "retiredAt" IS NULL`,
            [actor.orgId, cmd.projectId, actor.accountId],
          );
          const id = randomUUID();
          await client.query(
            `INSERT INTO "FieldEntryCode"(id,"orgId","projectId",code,"createdBy") VALUES($1,$2,$3,$4,$5)`,
            [
              id,
              actor.orgId,
              cmd.projectId,
              randomBytes(16).toString('base64url'),
              actor.accountId,
            ],
          );
          await audit(
            client,
            actor,
            { type: 'FIELD_ENTRY_CODE', id, version: 1 },
            'FIELD_ENTRY_ROTATE',
            '',
            null,
            { entryCodeId: id },
            cmd.clientMutationId,
          );
          // The stored replay holds only the id; the code is read from its row.
          return { status: 200, body: { entryCodeId: id } };
        },
      );
      const { entryCodeId } = settled(o);
      const r = await client.query<{ code: string; retiredAt: Date | null }>(
        `SELECT code, "retiredAt" FROM "FieldEntryCode" WHERE "orgId"=$1 AND id=$2`,
        [actor.orgId, entryCodeId],
      );
      return { code: r.rows[0]!.code, active: r.rows[0]!.retiredAt === null };
    });
  }
  async roster(identity: Identity, projectId: string): Promise<RosterDto> {
    return this.pm(identity, projectId, (client, actor) =>
      readRoster(client, actor.orgId, projectId),
    );
  }
  async createCrew(identity: Identity, cmd: CreateCrewCommand) {
    return this.rosterWrite(
      identity,
      cmd.projectId,
      'FIELD_CREW_CREATE',
      cmd,
      (c, a) => createCrew(c, a, cmd),
    );
  }
  async endCrew(identity: Identity, cmd: EndCrewCommand) {
    return this.rosterWrite(
      identity,
      cmd.projectId,
      'FIELD_CREW_END',
      cmd,
      (c, a) => endCrew(c, a, cmd),
    );
  }
  async changeRoster(identity: Identity, cmd: RosterChangesCommand) {
    return this.rosterWrite(
      identity,
      cmd.projectId,
      'FIELD_ROSTER_CHANGE',
      cmd,
      (c, a) => changeRoster(c, a, cmd),
    );
  }
}

/**
 * Field roster and entry (A6a-1; design docs/architecture/a6-field-devices-design.md §1, §2
 * entry code, §5, §6). The project entry code allows only the roster read (and, with A6a-2,
 * bind). PM routes are Entra PROJECT_MANAGER writes through `inTransaction`; roster writes take
 * the project roster lock and increment the roster version. Field devices arrive with A6a-2.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CreateCrewCommand,
  EndCrewCommand,
  EntryCommand,
  EntryDto,
  RosterChangesCommand,
  RosterDto,
  RotateEntryCodeCommand,
} from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import {
  FieldError,
  FieldThrottle,
  LIMITS,
  fieldIdempotent,
  settled,
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

export class FieldStore {
  readonly throttle: FieldThrottle;
  constructor(private readonly pool: Pool) {
    this.throttle = new FieldThrottle(pool);
  }

  // ---------- entry code: roster read ----------
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

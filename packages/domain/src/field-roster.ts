/**
 * Project roster (A6 design §1): crews and append-only CrewAssignment intervals. Every write
 * takes the project roster lock exclusively and increments ProjectRoster.version. (A6a-2 adds
 * the recomputation of the affected persons' device validity from the final interval set.)
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  CreateCrewCommand,
  EndCrewCommand,
  RosterChangesCommand,
  RosterDto,
} from '@mje/contracts';
import { FieldError, personLocks, rosterLock } from './field-kit.js';
import { audit, type Actor } from './store-kit.js';

/** Rows of a role that contain now (half-open). */
export const NOW_IN = (a: string) =>
  `${a}."validFrom" <= now() AND (${a}."validUntil" IS NULL OR now() < ${a}."validUntil")`;

/** ISO-8601 UTC with milliseconds, as `Date.toISOString()` writes it. */
const isoSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/**
 * The roster as one statement, so crews, intervals and the version come from one snapshot: a
 * roster write committing meanwhile is either wholly in the answer or wholly absent, and the
 * returned version always belongs to the returned rows (also on an idempotent replay).
 */
export async function readRoster(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<RosterDto> {
  const r = await client.query<Omit<RosterDto, 'projectId'>>(
    `SELECT
      COALESCE((SELECT version FROM "ProjectRoster" WHERE "orgId"=$1 AND "projectId"=$2), 0) AS "rosterVersion",
      COALESCE((SELECT json_agg(json_build_object('id', c.id, 'code', c.code, 'name', c.name,
          'activeFrom', ${isoSql('c."activeFrom"')}, 'activeUntil', ${isoSql('c."activeUntil"')}) ORDER BY c.code)
        FROM "Crew" c WHERE c."orgId"=$1 AND c."projectId"=$2), '[]'::json) AS crews,
      COALESCE((SELECT json_agg(json_build_object('id', a.id, 'crewId', a."crewId", 'personId', a."personId",
          'displayName', p."displayName", 'role', a.role,
          'validFrom', ${isoSql('a."validFrom"')}, 'validUntil', ${isoSql('a."validUntil"')}) ORDER BY a."validFrom", a.id)
        FROM "CrewAssignment" a JOIN "Person" p ON p."orgId"=a."orgId" AND p.id=a."personId"
        WHERE a."orgId"=$1 AND a."projectId"=$2), '[]'::json) AS assignments`,
    [orgId, projectId],
  );
  return { projectId, ...r.rows[0]! };
}
export async function rosterVersion(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<number> {
  const r = await client.query<{ version: number }>(
    `SELECT version FROM "ProjectRoster" WHERE "orgId"=$1 AND "projectId"=$2`,
    [orgId, projectId],
  );
  return r.rows[0]?.version ?? 0;
}
/** Level 0 exclusive, then the caller's expected version. */
async function beginRosterWrite(
  client: PoolClient,
  orgId: string,
  projectId: string,
  expected: number,
) {
  await rosterLock(client, orgId, projectId);
  if ((await rosterVersion(client, orgId, projectId)) !== expected)
    throw new FieldError('VERSION_CONFLICT');
}
async function bumpRoster(
  client: PoolClient,
  orgId: string,
  projectId: string,
) {
  const r = await client.query<{ version: number }>(
    `INSERT INTO "ProjectRoster"(id,"orgId","projectId",version) VALUES($1,$2,$3,1)
    ON CONFLICT ("orgId","projectId") DO UPDATE SET version="ProjectRoster".version+1, "updatedAt"=now()
    RETURNING version`,
    [randomUUID(), orgId, projectId],
  );
  return r.rows[0]!.version;
}
/** `at` (or now when null) is not in the past and not before `notBefore`. */
async function timeOk(
  client: PoolClient,
  at: string | null,
  notBefore: Date | null = null,
): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(
    `SELECT COALESCE($1::timestamptz, now()) >= now() AND ($2::timestamptz IS NULL OR COALESCE($1::timestamptz, now()) >= $2::timestamptz) AS ok`,
    [at, notBefore],
  );
  return r.rows[0]!.ok;
}

export async function createCrew(
  client: PoolClient,
  actor: Actor,
  cmd: CreateCrewCommand,
): Promise<number> {
  await beginRosterWrite(
    client,
    actor.orgId,
    cmd.projectId,
    cmd.expectedRosterVersion,
  );
  const taken = await client.query(
    `SELECT 1 FROM "Crew" WHERE "orgId"=$1 AND "projectId"=$2 AND code=$3`,
    [actor.orgId, cmd.projectId, cmd.code],
  );
  if (taken.rowCount) throw new FieldError('CREW_CODE_TAKEN');
  const id = randomUUID();
  await client.query(
    `INSERT INTO "Crew"(id,"orgId","projectId",code,name,"createdBy") VALUES($1,$2,$3,$4,$5,$6)`,
    [id, actor.orgId, cmd.projectId, cmd.code, cmd.name, actor.accountId],
  );
  const version = await bumpRoster(client, actor.orgId, cmd.projectId);
  await audit(
    client,
    actor,
    { type: 'PROJECT_ROSTER', id: cmd.projectId, version },
    'FIELD_CREW_CREATE',
    '',
    null,
    { crewId: id, code: cmd.code },
    cmd.clientMutationId,
  );
  return version;
}

/** Ends a crew once no interval of it reaches past the end. Returns the new roster version. */
export async function endCrew(
  client: PoolClient,
  actor: Actor,
  cmd: EndCrewCommand,
): Promise<number> {
  await beginRosterWrite(
    client,
    actor.orgId,
    cmd.projectId,
    cmd.expectedRosterVersion,
  );
  const crew = await client.query<{
    activeFrom: Date;
    activeUntil: Date | null;
  }>(
    `SELECT "activeFrom", "activeUntil" FROM "Crew" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3`,
    [actor.orgId, cmd.projectId, cmd.crewId],
  );
  const c = crew.rows[0];
  if (!c) throw new FieldError('NOT_FOUND');
  if (c.activeUntil) throw new FieldError('CREW_ENDED');
  if (!(await timeOk(client, cmd.at, c.activeFrom)))
    throw new FieldError('ROSTER_TIME_INVALID');
  const open = await client.query(
    `SELECT 1 FROM "CrewAssignment" WHERE "orgId"=$1 AND "crewId"=$2
      AND ("validUntil" IS NULL OR "validUntil" > COALESCE($3::timestamptz, now())) LIMIT 1`,
    [actor.orgId, cmd.crewId, cmd.at],
  );
  if (open.rowCount) throw new FieldError('CREW_NOT_EMPTY');
  await client.query(
    `UPDATE "Crew" SET "activeUntil"=COALESCE($3::timestamptz, now()) WHERE "orgId"=$1 AND id=$2`,
    [actor.orgId, cmd.crewId, cmd.at],
  );
  const version = await bumpRoster(client, actor.orgId, cmd.projectId);
  await audit(
    client,
    actor,
    { type: 'PROJECT_ROSTER', id: cmd.projectId, version },
    'FIELD_CREW_END',
    '',
    null,
    { crewId: cmd.crewId, at: cmd.at },
    cmd.clientMutationId,
  );
  return version;
}

/**
 * Assign, transfer, hand over or terminate, in one transaction: every close first, then every
 * open, so a transfer or handover at one instant is continuous.
 */
export async function changeRoster(
  client: PoolClient,
  actor: Actor,
  cmd: RosterChangesCommand,
): Promise<number> {
  const { orgId } = actor;
  const { projectId } = cmd;
  await beginRosterWrite(client, orgId, projectId, cmd.expectedRosterVersion);
  const closes = cmd.changes.flatMap((c) => (c.op === 'close' ? [c] : []));
  const opens = cmd.changes.flatMap((c) => (c.op === 'open' ? [c] : []));
  const closing = await client.query<{
    id: string;
    personId: string;
    validFrom: Date;
    validUntil: Date | null;
  }>(
    `SELECT id, "personId", "validFrom", "validUntil" FROM "CrewAssignment"
    WHERE "orgId"=$1 AND "projectId"=$2 AND id = ANY($3::uuid[])`,
    [orgId, projectId, closes.map((c) => c.assignmentId)],
  );
  const byId = new Map(closing.rows.map((r) => [r.id, r]));
  for (const c of closes) {
    const row = byId.get(c.assignmentId);
    if (!row) throw new FieldError('NOT_FOUND');
    if (row.validUntil) throw new FieldError('ASSIGNMENT_CLOSED');
    if (!(await timeOk(client, c.at, row.validFrom)))
      throw new FieldError('ROSTER_TIME_INVALID');
  }
  for (const o of opens) {
    const crew = await client.query<{
      activeFrom: Date;
      activeUntil: Date | null;
    }>(
      `SELECT "activeFrom", "activeUntil" FROM "Crew" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3`,
      [orgId, projectId, o.crewId],
    );
    const person = await client.query(
      `SELECT 1 FROM "Person" WHERE "orgId"=$1 AND id=$2`,
      [orgId, o.personId],
    );
    if (!crew.rows[0] || !person.rowCount) throw new FieldError('NOT_FOUND');
    if (crew.rows[0].activeUntil) throw new FieldError('CREW_ENDED');
    if (!(await timeOk(client, o.from, crew.rows[0].activeFrom)))
      throw new FieldError('ROSTER_TIME_INVALID');
  }
  const persons = [
    ...new Set([
      ...closes.map((c) => byId.get(c.assignmentId)!.personId),
      ...opens.map((o) => o.personId),
    ]),
  ].sort();
  // Level 1: every person whose intervals change (the trigger takes the same locks).
  await personLocks(client, orgId, projectId, persons);
  for (const c of closes)
    await client.query(
      `UPDATE "CrewAssignment" SET "validUntil"=COALESCE($3::timestamptz, now()), "closedBy"=$4
      WHERE "orgId"=$1 AND id=$2 AND "validUntil" IS NULL`,
      [orgId, c.assignmentId, c.at, actor.accountId],
    );
  const opened: string[] = [];
  for (const o of opens) {
    const id = randomUUID();
    try {
      await client.query(
        `INSERT INTO "CrewAssignment"(id,"orgId","projectId","crewId","personId",role,"validFrom","createdBy")
        VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8)`,
        [
          id,
          orgId,
          projectId,
          o.crewId,
          o.personId,
          o.role,
          o.from,
          actor.accountId,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23P01')
        throw new FieldError('ASSIGNMENT_OVERLAP');
      throw error;
    }
    opened.push(id);
  }
  const version = await bumpRoster(client, orgId, projectId);
  await audit(
    client,
    actor,
    { type: 'PROJECT_ROSTER', id: projectId, version },
    'FIELD_ROSTER_CHANGE',
    '',
    null,
    {
      closed: closes.map((c) => ({ id: c.assignmentId, at: c.at })),
      opened: opens.map((o, i) => ({
        id: opened[i],
        crewId: o.crewId,
        personId: o.personId,
        role: o.role,
        from: o.from,
      })),
    },
    cmd.clientMutationId,
  );
  return version;
}

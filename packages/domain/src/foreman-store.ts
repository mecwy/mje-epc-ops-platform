/**
 * Foreman quantity reports (A6c; design docs/architecture/a6-field-devices-design.md §4, §5,
 * §6). A report is the foreman's claim of the crew's quantities for a business day: insert-only
 * numbered revisions per (project, day, crew), no hours, never a verified fact and never copied
 * into the report facts on its own. The PM adopts a COMPLETE total explicitly (ReportStore).
 *
 * Device routes authenticate through `fieldTransaction` (A6a bootstrap, decision time and clock
 * guard). Lock order (§5): idempotency key (I) → device row share (2) → report day (4) → report
 * header (6) → FieldDay counter (7). The decision time is taken after the day lock, so a report
 * that waited on a submission is judged after it; `receivedAt` is that time.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ForemanBasisDto,
  ForemanDayDto,
  ForemanReportCommand,
  ForemanReportDto,
  ForemanReportRowDto,
} from '@mje/contracts';
import {
  FieldError,
  FieldThrottle,
  fieldIdempotent,
  fieldTransaction,
  settled,
  type DeviceRow,
} from './field-kit.js';
import { rosterVersion } from './field-roster.js';
import { localDate } from './checkin-rules.js';
import { nextSeq, submittedBoundary } from './checkin-store.js';
import {
  dec,
  foremanDateAllowed,
  foremanTotals,
  type ForemanReport,
} from './report-rules.js';
import { lockReportDay } from './store-kit.js';
import { activeWorkItemCatalog } from './report-lookups.js';

export interface ForemanStoreOptions {
  /** TEST seam, read per request: false switches deferred housekeeping off. */
  housekeeping?: boolean;
}
export interface ForemanReportResultDto {
  crewId: string;
  businessDate: string;
  n: number;
  revisionId: string;
  daySeq: number;
  receivedAt: string;
  /** Numbered after the day's latest submission: it enters only through a correction. */
  afterSubmission: boolean;
}

/** '' | 'unknown' | 'na' | a decimal (comma accepted, normalized); anything else is null. */
export function foremanQty(raw: string): string | null {
  const s = raw.trim();
  if (s === '' || s === 'unknown' || s === 'na') return s;
  return dec(s) === null ? null : s.replace(',', '.');
}

// ---------- shared reads (the caller holds the locks their consistency needs) ----------
/**
 * The expected crew set of a business day (§4): every crew with a MEMBER or a FOREMAN interval
 * overlapping [00:00, 24:00) in the site timezone. It does not depend on a foreman being
 * assigned: a staffed crew without one is expected (hasForeman false).
 */
export async function expectedCrews(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
  timeZone: string,
): Promise<ForemanDayDto['expectedCrews']> {
  const r = await client.query<ForemanDayDto['expectedCrews'][number]>(
    `SELECT c.id AS "crewId", c.code, c.name, bool_or(a.role = 'FOREMAN') AS "hasForeman"
    FROM "CrewAssignment" a JOIN "Crew" c ON c."orgId"=a."orgId" AND c."projectId"=a."projectId" AND c.id=a."crewId"
    WHERE a."orgId"=$1 AND a."projectId"=$2
      AND tstzrange(a."validFrom", a."validUntil", '[)')
        && tstzrange(($3::date)::timestamp AT TIME ZONE $4, ($3::date + 1)::timestamp AT TIME ZONE $4, '[)')
    GROUP BY c.id, c.code, c.name ORDER BY c.code, c.id`,
    [orgId, projectId, businessDate, timeZone],
  );
  return r.rows;
}
interface LatestRevision {
  crewId: string;
  revisionId: string;
  n: number;
  rows: ForemanReportRowDto[];
  note: string;
  daySeq: string;
  occurredAt: Date;
  receivedAt: Date;
}
async function latestRevisions(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
  crewId: string | null = null,
): Promise<LatestRevision[]> {
  const r = await client.query<LatestRevision>(
    `SELECT h."crewId", v.id AS "revisionId", v.n, v.rows, v.note, v."daySeq", v."occurredAt", v."receivedAt"
    FROM "ForemanReport" h JOIN "ForemanReportRevision" v
      ON v."orgId"=h."orgId" AND v."projectId"=h."projectId" AND v."reportId"=h.id AND v.n=h."currentN"
    WHERE h."orgId"=$1 AND h."projectId"=$2 AND h."businessDate"=$3::date AND ($4::uuid IS NULL OR h."crewId"=$4)
    ORDER BY h."crewId"`,
    [orgId, projectId, businessDate, crewId],
  );
  return r.rows;
}
/**
 * The writer's view of the day's foreman reports, and what a submission freezes of them: the
 * roster version, the expected crew set derived from it, each crew's latest revision, per-item
 * statuses and totals, and the adoptions. The caller holds the shared project roster lock (the
 * crew set cannot change meanwhile) and, for a submission, the report day lock.
 */
export async function foremanDayAsOf(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
  timeZone: string,
  workItems: string[],
): Promise<ForemanDayDto> {
  const version = await rosterVersion(client, orgId, projectId);
  const crews = await expectedCrews(
    client,
    orgId,
    projectId,
    businessDate,
    timeZone,
  );
  const latest = await latestRevisions(client, orgId, projectId, businessDate);
  const reports: ForemanReport[] = latest.map((l) => ({
    crew: l.crewId,
    n: l.n,
    rows: l.rows.map((x) => ({ item: x.itemKey, qty: x.qty })),
  }));
  const adoptions = await client.query<{
    id: string;
    itemKey: string;
    value: string;
    basis: ForemanBasisDto;
    daySeq: string;
    byAccountId: string;
    createdAt: Date;
  }>(
    `SELECT id, "itemKey", trim_scale(value)::text AS value, basis, "daySeq", "byAccountId", "createdAt"
    FROM "ForemanAdoption" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date ORDER BY "daySeq"`,
    [orgId, projectId, businessDate],
  );
  const byCrew = new Map(latest.map((l) => [l.crewId, l.n]));
  return {
    rosterVersion: version,
    expectedCrews: crews,
    revisions: latest.map((l) => ({
      crewId: l.crewId,
      revisionId: l.revisionId,
      n: l.n,
      daySeq: Number(l.daySeq),
      receivedAt: l.receivedAt.toISOString(),
    })),
    items: foremanTotals(
      crews.map((c) => c.crewId),
      reports,
      workItems,
    ),
    adoptions: adoptions.rows.map((a) => ({
      id: a.id,
      itemKey: a.itemKey,
      value: a.value,
      basis: a.basis,
      daySeq: Number(a.daySeq),
      byAccountId: a.byAccountId,
      at: a.createdAt.toISOString(),
    })),
    basis: {
      rosterVersion: version,
      expectedCrews: crews.map((c) => c.crewId),
      revisions: crews.map((c) => ({
        crewId: c.crewId,
        n: byCrew.get(c.crewId) ?? null,
      })),
    },
  };
}
export class ForemanStore {
  readonly throttle: FieldThrottle;
  constructor(
    private readonly pool: Pool,
    private readonly options: ForemanStoreOptions = {},
  ) {
    this.throttle = new FieldThrottle(pool);
  }
  private get deferred() {
    return this.options.housekeeping !== false;
  }
  private async timezone(client: PoolClient, d: DeviceRow): Promise<string> {
    const r = await client.query<{ timezone: string }>(
      `SELECT timezone FROM "Project" WHERE "orgId"=$1 AND id=$2`,
      [d.orgId, d.projectId],
    );
    const tz = r.rows[0]!.timezone;
    // An invalid master-data zone must never silently become the server's.
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  }
  /** The actor's FOREMAN crew at the decision time; none → NOT_FOREMAN. */
  private async foremanCrew(
    client: PoolClient,
    d: DeviceRow,
    at: string,
  ): Promise<{ id: string; name: string }> {
    const r = await client.query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM "CrewAssignment" a JOIN "Crew" c ON c."orgId"=a."orgId" AND c.id=a."crewId"
      WHERE a."orgId"=$1 AND a."projectId"=$2 AND a."personId"=$3 AND a.role='FOREMAN'
        AND a."validFrom" <= $4::timestamptz AND (a."validUntil" IS NULL OR $4::timestamptz < a."validUntil")`,
      [d.orgId, d.projectId, d.personId, at],
    );
    if (!r.rows[0]) throw new FieldError('NOT_FOREMAN');
    return r.rows[0];
  }
  /**
   * §1 historical writes: the site's today or yesterday at the decision time (never a client
   * date); older days are PM-only, a future day is not a report. The crew must be expected that
   * day (staffed or with a foreman), so a report is never outside the day's expected crew set.
   */
  private async admitDate(
    client: PoolClient,
    d: DeviceRow,
    crewId: string,
    businessDate: string,
    t: Date,
  ): Promise<string> {
    const tz = await this.timezone(client, d);
    const allowed = foremanDateAllowed(businessDate, localDate(t, tz));
    if (allowed === 'future') throw new FieldError('TIME_ORDER_INVALID');
    if (allowed === 'tooOld') throw new FieldError('TOO_LATE');
    const crews = await expectedCrews(
      client,
      d.orgId,
      d.projectId,
      businessDate,
      tz,
    );
    if (!crews.some((c) => c.crewId === crewId))
      throw new FieldError('NOT_FOREMAN');
    return tz;
  }
  private async workItems(client: PoolClient, d: DeviceRow) {
    return activeWorkItemCatalog(client, d.orgId, d.projectId);
  }

  /** The foreman's own current crew's latest report for the site's today or yesterday. */
  async report(
    ip: string,
    tokenHash: string,
    businessDate: string,
  ): Promise<ForemanReportDto> {
    return fieldTransaction(
      this.pool,
      this.throttle,
      tokenHash,
      ip,
      { deferred: this.deferred },
      async (client, { device: d, now: t, at }) => {
        const crew = await this.foremanCrew(client, d, at);
        await this.admitDate(client, d, crew.id, businessDate, t);
        const [latest] = await latestRevisions(
          client,
          d.orgId,
          d.projectId,
          businessDate,
          crew.id,
        );
        return {
          crewId: crew.id,
          crewName: crew.name,
          businessDate,
          n: latest?.n ?? 0,
          rows: latest?.rows ?? [],
          note: latest?.note ?? '',
          occurredAt: latest ? latest.occurredAt.toISOString() : null,
          receivedAt: latest ? latest.receivedAt.toISOString() : null,
          items: await this.workItems(client, d),
        };
      },
    );
  }

  /**
   * A new revision of the crew's report for the day: `expectedRevision` must be the current
   * one (REVISION_CONFLICT), every key a project work item (ITEM_NOT_FOUND), every quantity a
   * decimal within Decimal(20,6), 'unknown', 'na' or blank (NUMBER_INVALID). Authority is
   * re-checked on a replay; the date rule is judged on the first attempt only.
   */
  async submitReport(
    ip: string,
    tokenHash: string,
    cmd: ForemanReportCommand,
  ): Promise<ForemanReportResultDto> {
    const route = 'FIELD_FOREMAN_REPORT';
    return fieldTransaction(
      this.pool,
      this.throttle,
      tokenHash,
      ip,
      {
        deferred: this.deferred,
        keyLock: { route, key: cmd.clientMutationId },
        // Level 4 before the decision time: a report that waited on a submission is judged
        // (and numbered) after it.
        afterLock: (client, d) =>
          lockReportDay(client, d.orgId, d.projectId, cmd.businessDate),
      },
      async (client, { device: d, now: t, at }) => {
        // Resource authorization before the idempotency lookup, so a replay re-runs it.
        const crew = await this.foremanCrew(client, d, at);
        if (crew.id !== cmd.crewId) throw new FieldError('NOT_FOREMAN');
        return settled(
          await fieldIdempotent<ForemanReportResultDto>(
            client,
            d.orgId,
            d.id,
            route,
            cmd.clientMutationId,
            cmd,
            async () => {
              const tz = await this.admitDate(
                client,
                d,
                crew.id,
                cmd.businessDate,
                t,
              );
              const items = new Set(
                (await this.workItems(client, d)).map((i) => i.key),
              );
              if (cmd.rows.some((r) => !items.has(r.itemKey)))
                throw new FieldError('ITEM_NOT_FOUND');
              const rows = cmd.rows.map((r) => ({
                itemKey: r.itemKey,
                qty: foremanQty(r.qty),
              }));
              if (rows.some((r) => r.qty === null))
                throw new FieldError('NUMBER_INVALID');
              const header = await client.query<{
                id: string;
                currentN: number;
              }>(
                `SELECT id, "currentN" FROM "ForemanReport"
                WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date AND "crewId"=$4 FOR UPDATE`,
                [d.orgId, d.projectId, cmd.businessDate, crew.id],
              );
              const current = header.rows[0]?.currentN ?? 0;
              if (cmd.expectedRevision !== current)
                throw new FieldError('REVISION_CONFLICT');
              const n = current + 1;
              let reportId = header.rows[0]?.id;
              if (reportId)
                await client.query(
                  `UPDATE "ForemanReport" SET "currentN"=$3 WHERE "orgId"=$1 AND id=$2`,
                  [d.orgId, reportId, n],
                );
              else {
                reportId = randomUUID();
                await client.query(
                  `INSERT INTO "ForemanReport"(id,"orgId","projectId","crewId","businessDate","currentN") VALUES($1,$2,$3,$4,$5::date,1)`,
                  [reportId, d.orgId, d.projectId, crew.id, cmd.businessDate],
                );
              }
              const boundary = await submittedBoundary(
                client,
                d.orgId,
                d.projectId,
                cmd.businessDate,
              );
              const daySeq = await nextSeq(
                client,
                d.orgId,
                d.projectId,
                cmd.businessDate,
              );
              const revisionId = randomUUID();
              await client.query(
                `INSERT INTO "ForemanReportRevision"(id,"orgId","projectId","reportId",n,rows,note,"byPersonId","byDeviceId","occurredAt","receivedAt","siteTimezone","daySeq")
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13)`,
                [
                  revisionId,
                  d.orgId,
                  d.projectId,
                  reportId,
                  n,
                  JSON.stringify(rows),
                  cmd.note,
                  d.personId,
                  d.id,
                  cmd.occurredAt,
                  at,
                  tz,
                  daySeq,
                ],
              );
              return {
                status: 200,
                body: {
                  crewId: crew.id,
                  businessDate: cmd.businessDate,
                  n,
                  revisionId,
                  daySeq,
                  receivedAt: t.toISOString(),
                  afterSubmission: boundary !== null && daySeq > boundary,
                },
              };
            },
          ),
        );
      },
    );
  }
}

export interface ForemanAdoptionRow {
  id: string;
  orgId: string;
  projectId: string;
  businessDate: string;
  itemKey: string;
  value: string;
  /** The foreman basis serialised as JSON text. */
  basis: string;
  daySeq: number;
  byAccountId: string;
}

/**
 * Field module command exit (A7-0d): records the PM's adoption of a foreman total beside the
 * facts. Runs on the caller's PoolClient, so it joins the report transaction.
 */
export async function recordForemanAdoption(
  client: PoolClient,
  row: ForemanAdoptionRow,
): Promise<void> {
  await client.query(
    `INSERT INTO "ForemanAdoption"(id,"orgId","projectId","businessDate","itemKey",value,basis,"daySeq","byAccountId")
            VALUES($1,$2,$3,$4::date,$5,$6::numeric,$7,$8,$9)`,
    [
      row.id,
      row.orgId,
      row.projectId,
      row.businessDate,
      row.itemKey,
      row.value,
      row.basis,
      row.daySeq,
      row.byAccountId,
    ],
  );
}

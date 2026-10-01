import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CloseIssueCommand,
  CreateIssueCommand,
  DismissLagCommand,
  IssueNoteKind,
  NoteIssueCommand,
  ReopenIssueCommand,
  ReplyIssueCommand,
  SetEscalateCommand,
} from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import {
  canCloseByPm,
  canEscalate,
  lagSuggestions,
  shiftDate,
  type EscalationCategory,
  type LagDay,
} from './report-rules.js';
import {
  ReportError,
  audit,
  idempotent,
  inTransaction,
  projectAccess,
  projectWriter,
  type Actor,
} from './store-kit.js';
import { reportReader } from './report-reader.js';
import { withReportReadContext } from './report-read-context.js';

/**
 * Issues and escalation (U2.1 rule 10, 14; rule 1 through the report snapshot). An issue is a
 * to-do raised on a site business day. The project manager creates, notes, escalates, closes
 * and reopens; an executive reader only reads and replies. Escalation is the project manager's
 * decision: the lag reminder is a suggestion and never creates or escalates an issue. A close by
 * the project manager is not a verification, and expert-controlled issues cannot be closed here.
 */
export const ISSUE_KIND = 'SITE_REPORT';
/** States in which an issue no longer counts as open. */
const CLOSED_STATES = ['CLOSED', 'VERIFIED_CLOSED'];

/** An issue as stored (current state). Dates are site business dates (YYYY-MM-DD). */
export interface IssueRecord {
  id: string;
  projectId: string;
  title: string;
  category: EscalationCategory | '';
  escalate: boolean;
  controlled: boolean;
  workItemKey: string | null;
  ownerPersonId: string | null;
  dueOn: string | null;
  createdOn: string;
  closedOn: string | null;
  closedBy: string | null;
  state: string;
  version: number;
}
export interface IssueNoteView {
  id: string;
  kind: IssueNoteKind;
  text: string;
  onDate: string;
  authorPersonId: string;
  at: string;
}
export type IssueTransitionKind = 'close' | 'reopen';
export interface IssueTransitionView {
  kind: IssueTransitionKind;
  onDate: string;
  actorPersonId: string;
  at: string;
}
export interface IssueView extends IssueRecord {
  notes: IssueNoteView[];
  /** Effective-dated close/reopen history, oldest first. */
  transitions: IssueTransitionView[];
}
/** What a day shows (and a submission freezes) of one issue, as of that business day. */
export interface IssueAsOf {
  id: string;
  title: string;
  category: EscalationCategory | '';
  escalate: boolean;
  controlled: boolean;
  ownerPersonId: string | null;
  dueOn: string | null;
  workItemKey: string | null;
  status: 'open' | 'closed';
  closedToday: boolean;
  last: { kind: IssueNoteKind; text: string; onDate: string } | null;
}

const ISSUE_COLUMNS = `i.id, i."projectId", i.summary AS title, COALESCE(i.category, '') AS category, i.escalate, i.controlled,
  i."workItemKey", i."ownerPersonId", i."dueOn"::text AS "dueOn", i."createdOn"::text AS "createdOn",
  i."closedOn"::text AS "closedOn", i."closedBy", i.state::text AS state, i.version`;

/**
 * Issues shown on a business day: raised on or before it and, as of that day, either open or
 * closed on that very day. "As of" is the last close/reopen transition dated on or before the
 * day (ties: the one applied last, by sequence: database clocks can step backwards), so a later reopen never rewrites an earlier day. The last
 * note is also as of that day.
 */
export async function issuesAsOf(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<IssueAsOf[]> {
  return (await shownOn(client, orgId, projectId, businessDate)).map((i) =>
    asOf(i, businessDate),
  );
}
interface ShownRow extends IssueRecord {
  last: IssueAsOf['last'];
  /** Last transition on or before the day; null = never closed by then. */
  asOfKind: IssueTransitionKind | null;
  asOfOn: string | null;
}
async function shownOn(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<ShownRow[]> {
  const r = await client.query<ShownRow>(
    `SELECT ${ISSUE_COLUMNS}, t.kind AS "asOfKind", t."onDate"::text AS "asOfOn",
      (SELECT json_build_object('kind', n.kind, 'text', n.text, 'onDate', n."onDate"::text) FROM "IssueNote" n
        WHERE n."orgId"=i."orgId" AND n."issueId"=i.id AND n."onDate"<=$3::date
        ORDER BY n.seq DESC LIMIT 1) AS last
    FROM "Issue" i
    LEFT JOIN LATERAL (SELECT tr.kind, tr."onDate" FROM "IssueTransition" tr
      WHERE tr."orgId"=i."orgId" AND tr."issueId"=i.id AND tr."onDate"<=$3::date
      ORDER BY tr."onDate" DESC, tr.seq DESC LIMIT 1) t ON true
    WHERE i."orgId"=$1 AND i."projectId"=$2 AND i.kind=$4 AND i."createdOn"<=$3::date
      AND (t.kind IS DISTINCT FROM 'close' OR t."onDate"=$3::date)
    ORDER BY i."createdOn", i.seq`,
    [orgId, projectId, businessDate, ISSUE_KIND],
  );
  return r.rows;
}
function asOf(i: ShownRow, businessDate: string): IssueAsOf {
  const closed = i.asOfKind === 'close';
  return {
    id: i.id,
    title: i.title,
    category: i.category,
    escalate: i.escalate,
    controlled: i.controlled,
    ownerPersonId: i.ownerPersonId,
    dueOn: i.dueOn,
    workItemKey: i.workItemKey,
    status: closed ? 'closed' : 'open',
    closedToday: closed && i.asOfOn === businessDate,
    last: i.last,
  };
}

const pgCode = (e: unknown) =>
  e && typeof e === 'object' && 'code' in e ? e.code : undefined;
const pgConstraint = (e: unknown) =>
  e && typeof e === 'object' && 'constraint' in e ? e.constraint : undefined;

export class IssueStore {
  constructor(private readonly pool: Pool) {}

  // ---------- helpers ----------
  private async row(
    client: PoolClient,
    orgId: string,
    issueId: string,
    lock = false,
  ): Promise<IssueRecord> {
    const r = await client.query<IssueRecord>(
      `SELECT ${ISSUE_COLUMNS} FROM "Issue" i WHERE i."orgId"=$1 AND i.id=$2 AND i.kind=$3${lock ? ' FOR UPDATE' : ''}`,
      [orgId, issueId, ISSUE_KIND],
    );
    if (!r.rows[0]) throw new ReportError('NOT_FOUND');
    return r.rows[0];
  }
  private async notes(
    client: PoolClient,
    orgId: string,
    issueId: string,
    upTo: string | null = null,
  ): Promise<IssueNoteView[]> {
    const r = await client.query<Omit<IssueNoteView, 'at'> & { at: Date }>(
      `SELECT id, kind, text, "onDate"::text AS "onDate", "authorPersonId", "createdAt" AS at FROM "IssueNote"
      WHERE "orgId"=$1 AND "issueId"=$2 AND ($3::date IS NULL OR "onDate"<=$3::date) ORDER BY seq`,
      [orgId, issueId, upTo],
    );
    return r.rows.map((n) => ({ ...n, at: n.at.toISOString() }));
  }
  private async transitions(
    client: PoolClient,
    orgId: string,
    issueId: string,
  ): Promise<IssueTransitionView[]> {
    const r = await client.query<
      Omit<IssueTransitionView, 'at'> & { at: Date }
    >(
      `SELECT kind, "onDate"::text AS "onDate", "actorPersonId", "createdAt" AS at FROM "IssueTransition"
      WHERE "orgId"=$1 AND "issueId"=$2 ORDER BY "onDate", seq`,
      [orgId, issueId],
    );
    return r.rows.map((t) => ({ ...t, at: t.at.toISOString() }));
  }
  private async view(
    client: PoolClient,
    orgId: string,
    issueId: string,
  ): Promise<IssueView> {
    const issue = await this.row(client, orgId, issueId);
    return {
      ...issue,
      notes: await this.notes(client, orgId, issueId),
      transitions: await this.transitions(client, orgId, issueId),
    };
  }
  /** Transitions are effective-dated and must stay in business-date order. */
  private async lastTransition(
    client: PoolClient,
    orgId: string,
    issueId: string,
  ) {
    const all = await this.transitions(client, orgId, issueId);
    return all.at(-1) ?? null;
  }
  private async addTransition(
    client: PoolClient,
    actor: Actor,
    issueId: string,
    kind: IssueTransitionKind,
    onDate: string,
  ) {
    await client.query(
      `INSERT INTO "IssueTransition"(id,"orgId","issueId",kind,"onDate","actorAccountId","actorPersonId")
      VALUES($1,$2,$3,$4,$5::date,$6,$7)`,
      [
        randomUUID(),
        actor.orgId,
        issueId,
        kind,
        onDate,
        actor.accountId,
        actor.personId,
      ],
    );
  }
  /** The issue's project decides access; an issue outside the caller's org is simply not found. */
  private async forWrite(client: PoolClient, actor: Actor, issueId: string) {
    const issue = await this.row(client, actor.orgId, issueId);
    await projectWriter(client, actor, issue.projectId);
    return issue;
  }
  /** Re-read under a row lock and check the caller's expectedVersion. */
  private async locked(
    client: PoolClient,
    actor: Actor,
    issueId: string,
    expectedVersion: number,
  ): Promise<IssueRecord> {
    const issue = await this.row(client, actor.orgId, issueId, true);
    if (issue.version !== expectedVersion)
      throw new ReportError('VERSION_CONFLICT');
    return issue;
  }
  private async assertWorkItem(
    client: PoolClient,
    orgId: string,
    projectId: string,
    key: string,
  ) {
    const r = await client.query(
      `SELECT 1 FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 AND kind='work' AND key=$3 AND active`,
      [orgId, projectId, key],
    );
    if (!r.rowCount) throw new ReportError('ITEM_NOT_FOUND');
  }
  private async addNote(
    client: PoolClient,
    actor: Actor,
    issueId: string,
    kind: IssueNoteKind,
    text: string,
    onDate: string,
  ) {
    await client.query(
      `INSERT INTO "IssueNote"(id,"orgId","issueId",kind,text,"onDate","authorAccountId","authorPersonId")
      VALUES($1,$2,$3,$4,$5,$6::date,$7,$8)`,
      [
        randomUUID(),
        actor.orgId,
        issueId,
        kind,
        text,
        onDate,
        actor.accountId,
        actor.personId,
      ],
    );
  }
  private static audited(i: IssueRecord) {
    return {
      title: i.title,
      category: i.category,
      escalate: i.escalate,
      controlled: i.controlled,
      workItemKey: i.workItemKey,
      ownerPersonId: i.ownerPersonId,
      dueOn: i.dueOn,
      createdOn: i.createdOn,
      closedOn: i.closedOn,
      closedBy: i.closedBy,
      state: i.state,
    };
  }
  private async update(
    client: PoolClient,
    actor: Actor,
    before: IssueRecord,
    set: string,
    params: unknown[],
    action: string,
    reason: string,
    correlationId: string,
  ): Promise<IssueView> {
    await client.query(
      `UPDATE "Issue" SET ${set}, version=version+1, "updatedAt"=now(), "updatedBy"=$3 WHERE "orgId"=$1 AND id=$2`,
      [actor.orgId, before.id, actor.accountId, ...params],
    );
    const after = await this.view(client, actor.orgId, before.id);
    await audit(
      client,
      actor,
      { type: 'ISSUE', id: before.id, version: after.version },
      action,
      reason,
      IssueStore.audited(before),
      IssueStore.audited(after),
      correlationId,
    );
    return after;
  }

  // ---------- reads ----------
  /** Issues of a project on one business day, each as of that day, with the notes up to it. */
  async list(identity: Identity, projectId: string, businessDate: string) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const { access } = await projectAccess(client, actor, projectId);
      const issues = [];
      for (const row of await shownOn(
        client,
        actor.orgId,
        projectId,
        businessDate,
      ))
        issues.push({
          ...asOf(row, businessDate),
          // status/closedToday are as of the day; state, closedOn and version are current
          // (the version is what the next edit must send).
          createdOn: row.createdOn,
          closedOn: row.closedOn,
          state: row.state,
          version: row.version,
          notes: await this.notes(client, actor.orgId, row.id, businessDate),
        });
      return { access, projectId, businessDate, issues };
    });
  }

  async get(identity: Identity, issueId: string) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const issue = await this.view(client, actor.orgId, issueId);
      const { access } = await projectAccess(client, actor, issue.projectId);
      return { access, issue };
    });
  }

  /**
   * Rule 10 reminder: work items under 80 % of their baseline on 3 consecutive submitted days
   * ending on `businessDate`. Only submitted days count (the current revision's facts); the
   * baseline of a day is its latest confirmed plan version; a day that is not submitted breaks
   * the streak. Items with an open progress-lag issue, or dismissed for this day, are left out.
   */
  async lag(identity: Identity, projectId: string, businessDate: string) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const from = shiftDate(businessDate, -2);
      // The project check and the submitted days and confirmed plans come from the report
      // module exit (ADR-0003 D2): one authorization, then history, as before the exit.
      const history: LagDay[] = await withReportReadContext(
        client,
        actor,
        (ctx) => reportReader.lagHistory(ctx, projectId, from, businessDate),
      );
      // The reminder is about the requested day; without its submission there is nothing to say.
      if (!history.some((d) => d.businessDate === businessDate))
        return { projectId, businessDate, suggestions: [] };
      const open = await client.query<{ workItemKey: string }>(
        `SELECT DISTINCT "workItemKey" FROM "Issue" WHERE "orgId"=$1 AND "projectId"=$2 AND kind=$3
          AND category='progressLag' AND "workItemKey" IS NOT NULL AND state::text <> ALL($4::text[])`,
        [actor.orgId, projectId, ISSUE_KIND, CLOSED_STATES],
      );
      const dismissed = await client.query<{ workItemKey: string }>(
        `SELECT "workItemKey" FROM "LagDismissal" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date`,
        [actor.orgId, projectId, businessDate],
      );
      const items = lagSuggestions(
        history,
        new Set(open.rows.map((r) => r.workItemKey)),
        new Set(dismissed.rows.map((r) => r.workItemKey)),
      );
      return {
        projectId,
        businessDate,
        suggestions: items.map((workItemKey) => ({ workItemKey })),
      };
    });
  }

  // ---------- writes (project manager) ----------
  async create(identity: Identity, command: CreateIssueCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const project = await projectWriter(client, actor, command.projectId);
      return idempotent(
        client,
        actor,
        'ISSUE_CREATE',
        command.clientMutationId,
        command,
        async () => {
          if (
            command.escalate &&
            !canEscalate({
              controlled: command.controlled,
              category: command.category,
            })
          )
            throw new ReportError('CATEGORY_REQUIRED');
          if (command.workItemKey !== null)
            await this.assertWorkItem(
              client,
              actor.orgId,
              project.id,
              command.workItemKey,
            );
          const id = randomUUID();
          try {
            await client.query(
              `INSERT INTO "Issue"(id,"orgId","updatedAt","updatedBy",kind,state,summary,"projectId","ownerPersonId",
                category,escalate,controlled,"workItemKey","createdOn","dueOn")
              VALUES($1,$2,now(),$3,$4,'OPEN',$5,$6,$7,$8,$9,$10,$11,$12::date,$13::date)`,
              [
                id,
                actor.orgId,
                actor.accountId,
                ISSUE_KIND,
                command.title,
                project.id,
                command.ownerPersonId,
                command.category || null,
                command.escalate,
                command.controlled,
                command.workItemKey,
                command.businessDate,
                command.dueOn,
              ],
            );
          } catch (error) {
            // The composite (orgId, ownerPersonId) key refuses a person of another org too.
            if (
              pgCode(error) === '23503' &&
              pgConstraint(error) === 'Issue_orgId_ownerPersonId_fkey'
            )
              throw new ReportError('OWNER_NOT_FOUND');
            throw error;
          }
          if (command.note)
            await this.addNote(
              client,
              actor,
              id,
              'note',
              command.note,
              command.businessDate,
            );
          const after = await this.view(client, actor.orgId, id);
          await audit(
            client,
            actor,
            { type: 'ISSUE', id, version: after.version },
            'ISSUE_CREATE',
            command.businessDate,
            null,
            { ...IssueStore.audited(after), note: command.note },
            command.clientMutationId,
          );
          return after;
        },
      );
    });
  }

  async note(identity: Identity, command: NoteIssueCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      await this.forWrite(client, actor, command.issueId);
      return idempotent(
        client,
        actor,
        'ISSUE_NOTE',
        command.clientMutationId,
        command,
        async () => {
          const before = await this.locked(
            client,
            actor,
            command.issueId,
            command.expectedVersion,
          );
          await this.addNote(
            client,
            actor,
            before.id,
            'note',
            command.text,
            command.businessDate,
          );
          await client.query(
            `UPDATE "Issue" SET version=version+1, "updatedAt"=now(), "updatedBy"=$3 WHERE "orgId"=$1 AND id=$2`,
            [actor.orgId, before.id, actor.accountId],
          );
          const after = await this.view(client, actor.orgId, before.id);
          await audit(
            client,
            actor,
            { type: 'ISSUE', id: before.id, version: after.version },
            'ISSUE_NOTE',
            command.businessDate,
            null,
            { kind: 'note', text: command.text, onDate: command.businessDate },
            command.clientMutationId,
          );
          return after;
        },
      );
    });
  }

  /** Rule 10: escalation is the project manager's switch and needs a category. */
  async setEscalate(identity: Identity, command: SetEscalateCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      await this.forWrite(client, actor, command.issueId);
      return idempotent(
        client,
        actor,
        'ISSUE_ESCALATE',
        command.clientMutationId,
        command,
        async () => {
          const before = await this.locked(
            client,
            actor,
            command.issueId,
            command.expectedVersion,
          );
          const category = command.category || before.category;
          if (
            command.escalate &&
            !canEscalate({ controlled: before.controlled, category })
          )
            throw new ReportError('CATEGORY_REQUIRED');
          return this.update(
            client,
            actor,
            before,
            'category=$4, escalate=$5',
            [category || null, command.escalate],
            'ISSUE_ESCALATE',
            '',
            command.clientMutationId,
          );
        },
      );
    });
  }

  /** A project-manager close (state CLOSED) is not a verification; controlled issues need an expert. */
  async close(identity: Identity, command: CloseIssueCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      await this.forWrite(client, actor, command.issueId);
      return idempotent(
        client,
        actor,
        'ISSUE_CLOSE',
        command.clientMutationId,
        command,
        async () => {
          const before = await this.locked(
            client,
            actor,
            command.issueId,
            command.expectedVersion,
          );
          if (CLOSED_STATES.includes(before.state))
            throw new ReportError('ISSUE_CLOSED');
          if (!canCloseByPm(before)) throw new ReportError('NEEDS_EXPERT');
          if (command.businessDate < before.createdOn)
            throw new ReportError('DATE_BEFORE_CREATED');
          const last = await this.lastTransition(
            client,
            actor.orgId,
            before.id,
          );
          if (last && command.businessDate < last.onDate)
            throw new ReportError('DATE_BEFORE_REOPEN');
          await this.addTransition(
            client,
            actor,
            before.id,
            'close',
            command.businessDate,
          );
          return this.update(
            client,
            actor,
            before,
            `state='CLOSED', "closedOn"=$4::date, "closedBy"=$3`,
            [command.businessDate],
            'ISSUE_CLOSE',
            command.businessDate,
            command.clientMutationId,
          );
        },
      );
    });
  }

  async reopen(identity: Identity, command: ReopenIssueCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      await this.forWrite(client, actor, command.issueId);
      return idempotent(
        client,
        actor,
        'ISSUE_REOPEN',
        command.clientMutationId,
        command,
        async () => {
          const before = await this.locked(
            client,
            actor,
            command.issueId,
            command.expectedVersion,
          );
          // Only a project-manager close can be reopened here; a verified close is not ours to undo.
          if (before.state !== 'CLOSED')
            throw new ReportError('ISSUE_NOT_CLOSED');
          const last = await this.lastTransition(
            client,
            actor.orgId,
            before.id,
          );
          if (last && command.businessDate < last.onDate)
            throw new ReportError('DATE_BEFORE_CLOSE');
          await this.addTransition(
            client,
            actor,
            before.id,
            'reopen',
            command.businessDate,
          );
          return this.update(
            client,
            actor,
            before,
            `state='REOPENED', "closedOn"=NULL, "closedBy"=NULL`,
            [],
            'ISSUE_REOPEN',
            command.businessDate,
            command.clientMutationId,
          );
        },
      );
    });
  }

  async dismissLag(identity: Identity, command: DismissLagCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const project = await projectWriter(client, actor, command.projectId);
      return idempotent(
        client,
        actor,
        'ISSUE_LAG_DISMISS',
        command.clientMutationId,
        command,
        async () => {
          await this.assertWorkItem(
            client,
            actor.orgId,
            project.id,
            command.workItemKey,
          );
          const id = randomUUID();
          const inserted = await client.query(
            `INSERT INTO "LagDismissal"(id,"orgId","projectId","businessDate","workItemKey","dismissedBy")
            VALUES($1,$2,$3,$4::date,$5,$6) ON CONFLICT ("orgId","projectId","businessDate","workItemKey") DO NOTHING`,
            [
              id,
              actor.orgId,
              project.id,
              command.businessDate,
              command.workItemKey,
              actor.accountId,
            ],
          );
          // A second dismissal of the same item and day changes nothing and is not recorded twice.
          if (inserted.rowCount === 1)
            await audit(
              client,
              actor,
              { type: 'LAG_DISMISSAL', id, version: 1 },
              'ISSUE_LAG_DISMISS',
              command.businessDate,
              null,
              {
                projectId: project.id,
                businessDate: command.businessDate,
                workItemKey: command.workItemKey,
              },
              command.clientMutationId,
            );
          return {
            projectId: project.id,
            businessDate: command.businessDate,
            workItemKey: command.workItemKey,
            dismissed: true,
          };
        },
      );
    });
  }

  // ---------- executive reader ----------
  /** Rule 10: executives reply; a reply is appended to the issue record and changes nothing else. */
  async reply(identity: Identity, command: ReplyIssueCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const issue = await this.row(client, actor.orgId, command.issueId);
      const { access } = await projectAccess(client, actor, issue.projectId);
      // Replies are the executive voice; the project manager writes notes instead.
      if (access !== 'read') throw new ReportError('FORBIDDEN');
      return idempotent(
        client,
        actor,
        'ISSUE_REPLY',
        command.clientMutationId,
        command,
        async () => {
          await this.addNote(
            client,
            actor,
            issue.id,
            'reply',
            command.text,
            command.businessDate,
          );
          const after = await this.view(client, actor.orgId, issue.id);
          await audit(
            client,
            actor,
            { type: 'ISSUE', id: issue.id, version: after.version },
            'ISSUE_REPLY',
            command.businessDate,
            null,
            { kind: 'reply', text: command.text, onDate: command.businessDate },
            command.clientMutationId,
          );
          return after;
        },
      );
    });
  }
}

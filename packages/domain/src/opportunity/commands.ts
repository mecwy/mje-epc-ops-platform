import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  parseOpportunityFacts,
  blankOpportunityFacts,
  type OpportunityFacts,
  type OpportunityCommandResult,
  type CreateOpportunityCommand,
  type UpdateOpportunityCommand,
  type RequestOpportunityDecisionCommand,
  type RecordOpportunityDecisionCommand,
} from '@mje/contracts';
import type { Identity } from '../alpha-store.js';
import {
  accountTransaction,
  idempotent,
  audit,
  type Actor,
} from '../store-kit.js';
import { activeGrants, representedCanDecide } from './grants.js';
import {
  capabilities,
  canCreate,
  OpportunityError,
  restrictedFactsChanged,
  validateUpdate,
  type OpportunityGrant,
} from './rules.js';
import {
  stored,
  state,
  type StoredOpportunity,
  type StoredRecord,
} from './data.js';
type Command =
  | CreateOpportunityCommand
  | UpdateOpportunityCommand
  | RequestOpportunityDecisionCommand
  | RecordOpportunityDecisionCommand;
export class OpportunityCommands {
  constructor(private readonly pool: Pool) {}
  private tx<T>(
    identity: Identity,
    work: (c: PoolClient, a: Actor, g: OpportunityGrant[]) => Promise<T>,
    exclusiveAccount = false,
  ) {
    return accountTransaction(
      this.pool,
      identity,
      {
        exclusiveAccount,
        admit: (m) => m.length > 0,
        forbidden: () => new OpportunityError('FORBIDDEN'),
      },
      async (c, a) => work(c, a, await activeGrants(c, a)),
    );
  }
  private async lock(c: PoolClient, a: Actor, id: string) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `opportunity:${a.orgId}:${id}`,
    ]);
  }
  private async visible(
    c: PoolClient,
    a: Actor,
    g: OpportunityGrant[],
    id: string,
  ): Promise<StoredOpportunity> {
    const row = await stored(c, a.orgId, id);
    if (!row || !capabilities(g, id, state(row).facts).view)
      throw new OpportunityError('NOT_FOUND');
    return row;
  }
  private async append(
    c: PoolClient,
    a: Actor,
    command: Command,
    kind: StoredRecord['kind'],
    n: number,
    facts: OpportunityFacts,
  ) {
    const people = [
      ...new Set(
        [
          facts.informationOwnerPersonId,
          ...facts.assistantPersonIds,
          ...('nextStep' in command && command.nextStep.mode !== 'KEEP'
            ? [command.nextStep.next.ownerPersonId]
            : []),
          ...('requestedPersonId' in command
            ? [command.requestedPersonId]
            : []),
          ...('actualDecisionPersonId' in command
            ? [command.actualDecisionPersonId]
            : []),
        ].filter((x): x is string => x !== null),
      ),
    ];
    const companies = [
      ...new Set(
        facts.parties
          .map((x) => x.companyId)
          .filter((x): x is string => x !== null),
      ),
    ];
    const docs = [
      ...new Set(
        command.sources
          .map((x) => x.sourceDocumentId)
          .filter((x): x is string => x !== null),
      ),
    ];
    if (
      (
        await c.query(
          'SELECT id FROM "Person" WHERE "orgId"=$1 AND id=ANY($2::uuid[])',
          [a.orgId, people],
        )
      ).rows.length !== people.length ||
      (
        await c.query(
          'SELECT id FROM "Company" WHERE "orgId"=$1 AND id=ANY($2::uuid[])',
          [a.orgId, companies],
        )
      ).rows.length !== companies.length ||
      (
        await c.query(
          'SELECT id FROM "SourceDocument" WHERE "orgId"=$1 AND id=ANY($2::uuid[])',
          [a.orgId, docs],
        )
      ).rows.length !== docs.length
    )
      throw new OpportunityError('SOURCE_INVALID');
    const recordId = randomUUID();
    await c.query(
      `INSERT INTO "OpportunityRecord"(id,"orgId","opportunityId",n,kind,facts,payload,"recordedByAccountId","recordedByPersonId") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        recordId,
        a.orgId,
        command.opportunityId,
        n,
        kind,
        facts,
        command,
        a.accountId,
        a.personId,
      ],
    );
    for (const personId of people)
      await c.query(
        'INSERT INTO "OpportunityRecordPerson"(id,"orgId","recordId","personId") VALUES($1,$2,$3,$4)',
        [randomUUID(), a.orgId, recordId, personId],
      );
    for (const companyId of companies)
      await c.query(
        'INSERT INTO "OpportunityRecordCompany"(id,"orgId","recordId","companyId") VALUES($1,$2,$3,$4)',
        [randomUUID(), a.orgId, recordId, companyId],
      );
    for (const source of command.sources)
      await c.query(
        'INSERT INTO "OpportunityRecordSource"(id,"orgId","recordId","sourceDocumentId",reference,location) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          a.orgId,
          recordId,
          source.sourceDocumentId,
          source.reference,
          source.location,
        ],
      );
    if (n > 1)
      await c.query(
        'UPDATE "Opportunity" SET version=$3,"updatedAt"=clock_timestamp(),"updatedBy"=$4 WHERE "orgId"=$1 AND id=$2',
        [a.orgId, command.opportunityId, n, a.accountId],
      );
  }
  create(
    identity: Identity,
    command: CreateOpportunityCommand,
    key: string,
    correlation: string,
  ): Promise<OpportunityCommandResult> {
    return this.tx(
      identity,
      async (c, a, g) => {
        if (!canCreate(g)) throw new OpportunityError('FORBIDDEN');
        // No inherited view or monetary rights. A scoped creator may create an as-yet-unviewable lead.
        const sensitive =
          restrictedFactsChanged(
            blankOpportunityFacts(command.facts.name),
            command.facts,
          ) || command.sources.length > 0;
        if (
          sensitive &&
          !capabilities(g, command.opportunityId, command.facts).restrictedText
        )
          throw new OpportunityError('FORBIDDEN');
        return idempotent(
          c,
          a,
          'opportunity.create',
          key,
          command,
          async () => {
            const code = command.code ?? `OPP-${command.opportunityId}`;
            // Serialize the org/code uniqueness check across different record IDs and accounts.
            await c.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`opportunity-code:${a.orgId}:${code}`],
            );
            if (
              (
                await c.query(
                  'SELECT id FROM "Opportunity" WHERE "orgId"=$1 AND (id=$2 OR code=$3)',
                  [a.orgId, command.opportunityId, code],
                )
              ).rows.length
            )
              throw new OpportunityError('IDENTITY_EXISTS');
            await c.query(
              'INSERT INTO "Opportunity"(id,"orgId",code,stage,"updatedAt","updatedBy") VALUES($1,$2,$3,\'\',clock_timestamp(),$4)',
              [command.opportunityId, a.orgId, code, a.accountId],
            );
            await this.append(c, a, command, 'CREATE', 1, command.facts);
            await audit(
              c,
              a,
              { type: 'Opportunity', id: command.opportunityId, version: 1 },
              'create',
              '',
              null,
              command,
              correlation,
            );
            return { opportunityId: command.opportunityId, version: 1 };
          },
          (x) => x,
          async () => {
            await this.lock(c, a, command.opportunityId);
            if (!canCreate(await activeGrants(c, a)))
              throw new OpportunityError('FORBIDDEN');
          },
        );
      },
      true,
    );
  }
  private mutate(
    identity: Identity,
    command: Exclude<Command, CreateOpportunityCommand>,
    key: string,
    correlation: string,
    kind: 'UPDATE' | 'REQUEST' | 'DECISION',
    work: (
      c: PoolClient,
      a: Actor,
      g: OpportunityGrant[],
      row: StoredOpportunity,
    ) => Promise<OpportunityFacts>,
  ): Promise<OpportunityCommandResult> {
    return this.tx(identity, async (c, a, g) => {
      let row: StoredOpportunity;
      return idempotent(
        c,
        a,
        `opportunity.${kind.toLowerCase()}`,
        key,
        command,
        async () => {
          const facts = await work(c, a, g, row);
          const n = row.version + 1;
          await this.append(c, a, command, kind, n, facts);
          await audit(
            c,
            a,
            { type: 'Opportunity', id: command.opportunityId, version: n },
            kind.toLowerCase(),
            '',
            null,
            command,
            correlation,
          );
          return { opportunityId: command.opportunityId, version: n };
        },
        (x) => x,
        async () => {
          await this.lock(c, a, command.opportunityId);
          g = await activeGrants(c, a);
          row = await this.visible(c, a, g, command.opportunityId);
          const caps = capabilities(g, row.id, state(row).facts);
          if (!(kind === 'DECISION' ? caps.decide : caps.maintain))
            throw new OpportunityError('FORBIDDEN');
          // Replays recheck restricted ordinary text too, before consulting stored idempotency.
          if (kind === 'UPDATE')
            this.authorizeUpdate(g, row, command as UpdateOpportunityCommand);
          if (kind === 'DECISION')
            await this.authorizeDecision(
              c,
              a,
              row,
              command as RecordOpportunityDecisionCommand,
            );
        },
      );
    });
  }
  private authorizeUpdate(
    g: OpportunityGrant[],
    row: StoredOpportunity,
    command: UpdateOpportunityCommand,
  ) {
    const f = state(row).facts;
    // Authorization examines requested after fields, without requiring an old baseline to match on replay.
    const after = parseOpportunityFacts({
      ...f,
      ...Object.fromEntries(command.changes.map((x) => [x.field, x.after])),
    });
    const oldCaps = capabilities(g, row.id, f),
      newCaps = capabilities(g, row.id, after);
    if (!newCaps.maintain) throw new OpportunityError('FORBIDDEN');
    const text =
      !!command.evidence?.trim() ||
      !!command.obstacle?.trim() ||
      command.sources.length > 0 ||
      command.changes.some(
        (x) =>
          !!x.reason.trim() ||
          !!x.basis?.trim() ||
          x.field === 'internalNote' ||
          (x.field === 'ownerProject' &&
            restrictedFactsChanged(
              { ...f, ownerProject: x.before },
              { ...f, ownerProject: x.after },
            )),
      ) ||
      restrictedFactsChanged(f, after);
    if (text && (!oldCaps.restrictedText || !newCaps.restrictedText))
      throw new OpportunityError('FORBIDDEN');
  }
  update(
    identity: Identity,
    command: UpdateOpportunityCommand,
    key: string,
    correlation: string,
  ) {
    return this.mutate(
      identity,
      command,
      key,
      correlation,
      'UPDATE',
      async (_c, _a, _g, row) => {
        const s = state(row);
        return parseOpportunityFacts(
          validateUpdate(
            command,
            row.version,
            s.facts,
            s.step,
            s.steps.map((x) => x.id),
          ),
        );
      },
    );
  }
  request(
    identity: Identity,
    command: RequestOpportunityDecisionCommand,
    key: string,
    correlation: string,
  ) {
    return this.mutate(
      identity,
      command,
      key,
      correlation,
      'REQUEST',
      async (_c, _a, _g, row) => {
        const s = state(row);
        if (
          (s.request?.command.requestId ?? null) !== command.expectedRequestId
        )
          throw new OpportunityError('REQUEST_CONFLICT');
        if (
          row.records.some(
            (r) =>
              r.kind === 'REQUEST' && r.command.requestId === command.requestId,
          )
        )
          throw new OpportunityError('IDENTITY_EXISTS');
        return s.facts;
      },
    );
  }
  private async authorizeDecision(
    c: PoolClient,
    a: Actor,
    row: StoredOpportunity,
    command: RecordOpportunityDecisionCommand,
  ) {
    if (command.actualDecisionPersonId !== a.personId) {
      if (
        !command.proxy ||
        !(await representedCanDecide(
          c,
          a,
          command.actualDecisionPersonId,
          row.id,
        ))
      )
        throw new OpportunityError('PROXY_INVALID');
    } else if (command.proxy) throw new OpportunityError('PROXY_INVALID');
  }
  decide(
    identity: Identity,
    command: RecordOpportunityDecisionCommand,
    key: string,
    correlation: string,
  ) {
    return this.mutate(
      identity,
      command,
      key,
      correlation,
      'DECISION',
      async (_c, _a, _g, row) => {
        const s = state(row);
        if (s.decisionVersion !== command.expectedDecisionVersion)
          throw new OpportunityError('DECISION_CONFLICT');
        if (
          (s.request?.command.requestId ?? null) !== command.expectedRequestId
        )
          throw new OpportunityError('REQUEST_CONFLICT');
        return s.facts;
      },
    );
  }
}

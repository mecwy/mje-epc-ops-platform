import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ContractCommandResultDto,
  CreateContractCommand,
  CorrectContractCommand,
  SetContractSharesCommand,
  ReadContractAttentionCommand,
  ContractRevisionInput,
} from '@mje/contracts';
import type { Identity } from '../alpha-store.js';
import {
  accountTransaction,
  idempotent,
  audit,
  type Actor,
} from '../store-kit.js';
import { activeGrants } from './grants.js';
import {
  ContractRegisterError,
  allowsHeader,
  allowsProject,
  maintainsOrganization,
  maintainsProjects,
  type ContractGrant,
} from './rules.js';
import {
  identityRow,
  snapshot,
  currentShares,
  type ContractIdentity,
} from './data.js';
import {
  validateRevision,
  validateShares,
  needsCorrectionAttention,
} from './validation.js';

/** All contract/line/share dependency reads and writes share one contract transaction lock. */
async function lock(c: PoolClient, a: Actor, id: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `contract:${a.orgId}:${id}`,
  ]);
}
export class ContractRegisterCommands {
  constructor(private readonly pool: Pool) {}
  private tx<T>(
    identity: Identity,
    use: (c: PoolClient, a: Actor, g: ContractGrant[]) => Promise<T>,
  ): Promise<T> {
    return accountTransaction(
      this.pool,
      identity,
      {
        admit: (m) => m.length > 0,
        forbidden: () => new ContractRegisterError('FORBIDDEN'),
      },
      async (c, a) => use(c, a, await activeGrants(c, a)),
    );
  }
  private async visible(
    c: PoolClient,
    a: Actor,
    g: ContractGrant[],
    id: string,
  ): Promise<ContractIdentity> {
    const row = await identityRow(c, a.orgId, id);
    if (!row) throw new ContractRegisterError('NOT_FOUND');
    if (!allowsHeader(g, 'contract.view', row.direction)) {
      const shares = await currentShares(c, a.orgId, id);
      if (
        !shares.some(
          (s) =>
            !s.retired &&
            allowsProject(g, 'contract.view', row.direction, s.projectId),
        )
      )
        throw new ContractRegisterError('NOT_FOUND');
    }
    return row;
  }
  private async references(
    c: PoolClient,
    a: Actor,
    r: ContractRevisionInput,
  ): Promise<void> {
    const docs = [...new Set(r.sources.map((s) => s.sourceDocumentId))];
    if (
      (
        await c.query(
          'SELECT id FROM "SourceDocument" WHERE "orgId"=$1 AND id=ANY($2::uuid[])',
          [a.orgId, docs],
        )
      ).rows.length !== docs.length
    )
      throw new ContractRegisterError('SOURCE_INVALID');
    const companies = [
      ...new Set(
        [r.selfCompanyId, r.counterpartyCompanyId].filter(
          (s): s is string => s !== null,
        ),
      ),
    ];
    if (
      (
        await c.query(
          'SELECT id FROM "Company" WHERE "orgId"=$1 AND id=ANY($2::uuid[])',
          [a.orgId, companies],
        )
      ).rows.length !== companies.length
    )
      throw new ContractRegisterError('SOURCE_INVALID');
    if (
      r.informationOwnerPersonId &&
      !(
        await c.query('SELECT id FROM "Person" WHERE "orgId"=$1 AND id=$2', [
          a.orgId,
          r.informationOwnerPersonId,
        ])
      ).rows.length
    )
      throw new ContractRegisterError('SOURCE_INVALID');
  }
  private async append(
    c: PoolClient,
    a: Actor,
    id: string,
    n: number,
    r: ContractRevisionInput,
    reason: string | null,
  ): Promise<void> {
    await this.references(c, a, r);
    await c.query(
      `INSERT INTO "ContractRevision"(id,"orgId","contractId",n,name,"originalNumber","counterpartyRaw","selfPartyRaw","counterpartyCompanyId","selfCompanyId","informationOwnerPersonId","totalState","totalAmount",currency,"taxBasis","signedOnState","signedOn","effectiveOnState","effectiveOn","registrationStatus","partiesSourceId","partiesLocation","datesSourceId","datesLocation","totalSourceId","totalLocation","correctionReason","registeredBy","registeredByPersonId")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
      [
        randomUUID(),
        a.orgId,
        id,
        n,
        r.name,
        r.originalNumber,
        r.counterpartyRaw,
        r.selfPartyRaw,
        r.counterpartyCompanyId,
        r.selfCompanyId,
        r.informationOwnerPersonId,
        r.total.state,
        r.total.value,
        r.currency,
        r.taxBasis,
        r.signedOn.state,
        r.signedOn.value,
        r.effectiveOn.state,
        r.effectiveOn.value,
        r.registrationStatus,
        r.headLocs.parties?.sourceDocumentId ?? null,
        r.headLocs.parties?.location ?? null,
        r.headLocs.dates?.sourceDocumentId ?? null,
        r.headLocs.dates?.location ?? null,
        r.headLocs.total?.sourceDocumentId ?? null,
        r.headLocs.total?.location ?? null,
        reason,
        a.accountId,
        a.personId,
      ],
    );
    for (const s of r.sources)
      await c.query(
        'INSERT INTO "ContractRevisionSource"(id,"orgId","contractId",n,"sourceDocumentId",location) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), a.orgId, id, n, s.sourceDocumentId, s.location],
      );
    for (const l of r.lines) {
      const identity = (
        await c.query<{ contractId: string }>(
          'SELECT "contractId" FROM "ContractLine" WHERE id=$1',
          [l.id],
        )
      ).rows[0];
      if (identity && identity.contractId !== id)
        throw new ContractRegisterError('SOURCE_INVALID');
      if (!identity)
        await c.query(
          'INSERT INTO "ContractLine"(id,"orgId","contractId") VALUES($1,$2,$3)',
          [l.id, a.orgId, id],
        );
      await c.query(
        `INSERT INTO "ContractLineRevision"(id,"orgId","contractId","lineId",n,"lineNo",description,"quantityState",quantity,"unitRaw",unit,"pricingType","amountState",amount,includes,excludes,derivation,"sourceDocumentId",location,removed,"removalSourceDocumentId","removalLocation") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          randomUUID(),
          a.orgId,
          id,
          l.id,
          n,
          l.lineNo,
          l.description,
          l.quantity.state,
          l.quantity.value,
          l.unitRaw,
          l.unit,
          l.pricingType,
          l.amount.state,
          l.amount.value,
          l.includes,
          l.excludes,
          l.derivation,
          l.source?.sourceDocumentId ?? null,
          l.source?.location ?? null,
          l.removed,
          l.removalSource?.sourceDocumentId ?? null,
          l.removalSource?.location ?? null,
        ],
      );
    }
  }
  private async attention(
    c: PoolClient,
    a: Actor,
    id: string,
    n: number,
    kind: 'UNASSIGNED' | 'CORRECTION' | 'SHARE_MISASSIGNED',
    involved: string[],
  ): Promise<void> {
    await c.query(
      'INSERT INTO "ContractAttention"(id,"orgId","contractId","revisionN",kind,"causedByPersonId","involvedPersonIds") VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        randomUUID(),
        a.orgId,
        id,
        n,
        kind,
        a.personId,
        [...new Set([a.personId, ...involved])],
      ],
    );
  }
  create(
    identity: Identity,
    command: CreateContractCommand,
    key: string,
    correlationId: string,
  ): Promise<ContractCommandResultDto> {
    return this.tx(identity, async (c, a, g) => {
      if (!maintainsOrganization(g, command.direction))
        throw new ContractRegisterError('FORBIDDEN');
      return idempotent(c, a, 'contract.create', key, command, async () => {
        if (
          (
            await c.query(
              'SELECT id FROM "Contract" WHERE "orgId"=$1 AND (id=$2 OR code=$3)',
              [a.orgId, command.contractId, command.code],
            )
          ).rows.length
        )
          throw new ContractRegisterError('IDENTITY_EXISTS');
        validateRevision(command.revision, null);
        await c.query(
          'INSERT INTO "Contract"(id,"orgId",code,direction,"expenditureSubtype","createdBy") VALUES($1,$2,$3,$4,$5,$6)',
          [
            command.contractId,
            a.orgId,
            command.code,
            command.direction,
            command.expenditureSubtype,
            a.accountId,
          ],
        );
        await this.append(c, a, command.contractId, 1, command.revision, null);
        if (!command.revision.informationOwnerPersonId)
          await this.attention(c, a, command.contractId, 1, 'UNASSIGNED', []);
        await audit(
          c,
          a,
          { type: 'Contract', id: command.contractId, version: 1 },
          'create',
          '',
          null,
          command.revision,
          correlationId,
        );
        return { contractId: command.contractId, version: 1 };
      });
    });
  }
  correct(
    identity: Identity,
    command: CorrectContractCommand,
    key: string,
    correlationId: string,
  ): Promise<ContractCommandResultDto> {
    return this.tx(identity, async (c, a, g) => {
      const row = await this.visible(c, a, g, command.contractId);
      if (!maintainsOrganization(g, row.direction))
        throw new ContractRegisterError('FORBIDDEN');
      return idempotent(c, a, 'contract.correct', key, command, async () => {
        await lock(c, a, row.id);
        const old = await snapshot(c, a.orgId, row.id);
        if (!old || old.n !== command.expectedVersion)
          throw new ContractRegisterError('VERSION_CONFLICT');
        validateRevision(command.revision, old.revision);
        const n = old.n + 1;
        await this.append(c, a, row.id, n, command.revision, command.reason);
        if (needsCorrectionAttention(command.revision, old.revision))
          await this.attention(c, a, row.id, n, 'CORRECTION', [
            old.registeredByPersonId,
            ...[
              old.revision.informationOwnerPersonId,
              command.revision.informationOwnerPersonId,
            ].filter((p): p is string => p !== null),
          ]);
        if (!command.revision.informationOwnerPersonId)
          await this.attention(c, a, row.id, n, 'UNASSIGNED', [
            old.registeredByPersonId,
          ]);
        await audit(
          c,
          a,
          { type: 'Contract', id: row.id, version: n },
          'correct',
          command.reason,
          old.revision,
          command.revision,
          correlationId,
        );
        return { contractId: row.id, version: n };
      });
    });
  }
  shares(
    identity: Identity,
    command: SetContractSharesCommand,
    key: string,
    correlationId: string,
  ): Promise<ContractCommandResultDto> {
    return this.tx(identity, async (c, a, g) => {
      const row = await this.visible(c, a, g, command.contractId);
      // Authorization precedes replay and is repeated under the contract lock.
      const authorize = async () => {
        const current = await currentShares(c, a.orgId, row.id, command.lineId);
        const projects = [
          ...new Set([
            ...current.filter((s) => !s.retired).map((s) => s.projectId),
            ...command.shares.map((s) => s.projectId),
          ]),
        ];
        if (!maintainsProjects(g, row.direction, projects))
          throw new ContractRegisterError('FORBIDDEN');
        return current;
      };
      await authorize();
      return idempotent(
        c,
        a,
        'contract.shares',
        key,
        command,
        async () => {
          await lock(c, a, row.id);
          const current = await authorize();
          const old = await snapshot(c, a.orgId, row.id);
          if (!old || old.n !== command.expectedVersion)
            throw new ContractRegisterError('VERSION_CONFLICT');
          const line = old.revision.lines.find((l) => l.id === command.lineId);
          if (!line) throw new ContractRegisterError('NOT_FOUND');
          validateShares(line, current, command.shares);
          const projects = [...new Set(command.shares.map((s) => s.projectId))];
          if (
            (
              await c.query(
                'SELECT id FROM "Project" WHERE "orgId"=$1 AND id=ANY($2::uuid[])',
                [a.orgId, projects],
              )
            ).rows.length !== projects.length
          )
            throw new ContractRegisterError('SOURCE_INVALID');
          for (const s of command.shares) {
            const existing = current.find((x) => x.scopeId === s.scopeId);
            if (!existing) {
              if (
                (
                  await c.query(
                    'SELECT id FROM "ContractScope" WHERE "orgId"=$1 AND (id=$2 OR ("contractLineId"=$3 AND "projectId"=$4))',
                    [a.orgId, s.scopeId, line.id, s.projectId],
                  )
                ).rows.length
              )
                throw new ContractRegisterError('SHARE_INVALID');
              await c.query(
                'INSERT INTO "ContractScope"(id,"orgId","contractId","contractLineId","projectId",code,"pricingType","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,$1::uuid::text,\'UNKNOWN\',now(),$6)',
                [s.scopeId, a.orgId, row.id, line.id, s.projectId, a.accountId],
              );
            }
            await c.query(
              'INSERT INTO "ContractScopeVersion"(id,"orgId","contractId","lineId","scopeId",n,"contractRevisionN",basis,quantity,area,note,retired,reason,"registeredBy","registeredByPersonId") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
              [
                randomUUID(),
                a.orgId,
                row.id,
                line.id,
                s.scopeId,
                s.expectedVersion + 1,
                old.n,
                s.basis,
                s.quantity,
                s.area,
                s.note,
                s.retired,
                s.reason,
                a.accountId,
                a.personId,
              ],
            );
          }
          if (command.shares.some((s) => s.retired))
            await this.attention(c, a, row.id, old.n, 'SHARE_MISASSIGNED', [
              old.registeredByPersonId,
            ]);
          await audit(
            c,
            a,
            { type: 'ContractShares', id: line.id, version: old.n },
            'setShares',
            '',
            current,
            command.shares,
            correlationId,
          );
          return { contractId: row.id, version: old.n };
        },
        undefined,
        async () => {
          await lock(c, a, row.id);
          await this.visible(c, a, g, row.id);
          await authorize();
        },
      );
    });
  }
  readAttention(
    identity: Identity,
    command: ReadContractAttentionCommand,
    key: string,
    correlationId = randomUUID(),
  ): Promise<ContractCommandResultDto> {
    return this.tx(identity, async (c, a, g) => {
      const row = await this.visible(c, a, g, command.contractId);
      if (!allowsHeader(g, 'contract.attention', row.direction))
        throw new ContractRegisterError('FORBIDDEN');
      return idempotent(
        c,
        a,
        'contract.attention.read',
        key,
        command,
        async () => {
          const entry = (
            await c.query<{ revisionN: number }>(
              'SELECT "revisionN" FROM "ContractAttention" WHERE "orgId"=$1 AND "contractId"=$2 AND id=$3',
              [a.orgId, row.id, command.attentionId],
            )
          ).rows[0];
          if (!entry) throw new ContractRegisterError('NOT_FOUND');
          await c.query(
            'INSERT INTO "ContractAttentionRead"(id,"orgId","attentionId","byAccountId","byPersonId") VALUES($1,$2,$3,$4,$5) ON CONFLICT ("orgId","attentionId","byAccountId") DO NOTHING',
            [
              randomUUID(),
              a.orgId,
              command.attentionId,
              a.accountId,
              a.personId,
            ],
          );
          await audit(
            c,
            a,
            {
              type: 'ContractAttention',
              id: command.attentionId,
              version: entry.revisionN,
            },
            'read',
            '',
            null,
            { byAccountId: a.accountId, byPersonId: a.personId },
            correlationId,
          );
          return { contractId: row.id, version: entry.revisionN };
        },
        undefined,
        async () => {
          await lock(c, a, row.id);
          await this.visible(c, a, g, row.id);
        },
      );
    });
  }
}

// Synthetic TEST only. Reuses report-integration's isolated database, roles and HTTP server.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  MaterialContinuityStore,
  reportReader,
} from '../packages/domain/dist/index.js';
import { parseFacts } from '../packages/contracts/dist/index.js';
import { blankFacts } from '../packages/domain/dist/report-rules.js';

export async function materialContinuityChecks(f) {
  const {
    owner,
    appPool,
    reportStore,
    issueStore,
    activityMappings,
    call,
    expectStatus,
    pass,
    projectId,
    otherProjectId,
    orgId,
    otherOrgId,
    accountId,
    personId,
    identity,
    waitForLockWaiters,
    otherIdentity,
    pm,
    reader,
    otherProjectToken,
    foreignToken,
  } = f;
  const D1 = '2035-01-01',
    D2 = '2035-01-02',
    D3 = '2035-01-03',
    D4 = '2035-01-04';
  const workItemId = randomUUID(),
    materialItemId = randomUUID(),
    packageId = 'TEST-material-package';
  for (const item of [
    { id: workItemId, kind: 'work', key: 'testMaterialOutput' },
    { id: materialItemId, kind: 'material', key: 'testMaterialMount' },
  ])
    await owner.query(
      `INSERT INTO "ReportItem"(id,"orgId","projectId",kind,key,label,unit,"designQty","openingCumulative","sortOrder",active,"updatedBy") VALUES($1,$2,$3,$4,$5,'TEST material integration','set','10000','',99,true,$6)`,
      [item.id, orgId, projectId, item.kind, item.key, accountId],
    );
  const mapping = {
    orgId,
    projectId,
    workItemId,
    materialItemId,
    workPackageId: packageId,
    scopeVersion: '1',
    area: 'TEST-area',
    workItemKey: 'testMaterialOutput',
    materialKey: 'testMaterialMount',
    specification: 'TEST-spec',
    outputUnit: 'set',
    materialUnit: 'set',
    ruleId: 'TEST-one-to-one',
    ruleVersion: '1',
    mappingVersion: '1',
    ratio: '1',
    validFrom: D1,
    basisRef: 'TEST explicit mapping',
  };
  activityMappings.push(mapping);
  const material = new MaterialContinuityStore(appPool, issueStore);
  const day = (date) =>
    reportStore.read(identity, (ctx) =>
      reportReader.forContext(ctx).day(projectId, date),
    );
  const revisionRows = async () =>
    (
      await owner.query(
        `SELECT r.id,r."revisionNumber",r.snapshot FROM "Revision" r JOIN "DailyClose" d ON d."orgId"=r."orgId" AND d.id=r."dailyCloseId" WHERE d."projectId"=$1 ORDER BY d."businessDate",r."revisionNumber"`,
        [projectId],
      )
    ).rows;
  const hash = (value) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ledgerRows = async () => ({
    scopes: (
      await owner.query(
        `SELECT row_to_json(t) AS value FROM "MaterialQuantityScope" t WHERE "projectId"=$1 ORDER BY id`,
        [projectId],
      )
    ).rows,
    moves: (
      await owner.query(
        `SELECT row_to_json(t) AS value FROM "MaterialQuantityMovement" t JOIN "MaterialQuantityScope" s ON s.id=t."scopeId" WHERE s."projectId"=$1 ORDER BY t.sequence,t.id`,
        [projectId],
      )
    ).rows,
    links: (
      await owner.query(
        `SELECT row_to_json(t) AS value FROM "MaterialUseAdmission" t JOIN "MaterialQuantityScope" s ON s.id=t."scopeId" WHERE s."projectId"=$1 ORDER BY t.id`,
        [projectId],
      )
    ).rows,
  });
  const save = async (date, facts) =>
    expectStatus(
      call('/facts', pm, {
        projectId,
        businessDate: date,
        expectedVersion: (await day(date)).version,
        clientMutationId: randomUUID(),
        facts,
      }),
      200,
    );
  const submit = async (date) => {
    const d = await day(date);
    return expectStatus(
      call('/submit', pm, {
        projectId,
        businessDate: date,
        expectedVersion: d.version,
        clientMutationId: randomUUID(),
        activityUseConfirmation: {
          draftVersion: d.version,
          includedUseFactIds: (d.facts.activities ?? []).flatMap((a) =>
            a.use && a.use.state !== 'pending' ? [a.use.id] : [],
          ),
        },
      }),
      200,
    );
  };
  const correction = async (date) => {
    const d = await day(date);
    await reportStore.startCorrection(identity, {
      projectId,
      businessDate: date,
      expectedVersion: d.version,
      clientMutationId: randomUUID(),
      reason: 'TEST material correction',
    });
    return parseFacts(structuredClone((await day(date)).facts));
  };
  const facts = (a) => ({
    ...parseFacts(blankFacts()),
    activities: [a],
    qty: { testMaterialOutput: a.quantity },
    materials: { testMaterialMount: '0' },
  });
  function activity(output, use) {
    const outputFactId = randomUUID();
    return {
      operationId: randomUUID(),
      outputFactId,
      workItemId,
      workItemKey: mapping.workItemKey,
      workPackageId: packageId,
      scopeVersion: '1',
      area: mapping.area,
      process: 'TEST installation',
      completion: 'TEST',
      quantity: output,
      outputUnit: 'set',
      outputKind: 'installation',
      use: {
        id: randomUUID(),
        materialKey: mapping.materialKey,
        materialItemId,
        specification: mapping.specification,
        unit: 'set',
        estimate: {
          quantity: output,
          ruleId: mapping.ruleId,
          ruleVersion: '1',
          mappingVersion: '1',
          scopeRef: packageId + '@1',
          outputFactId,
          outputQuantity: output,
          workItemKey: mapping.workItemKey,
          materialKey: mapping.materialKey,
          specification: mapping.specification,
          outputUnit: 'set',
          materialUnit: 'set',
          ratio: '1',
        },
        actualQuantity: use,
        state: 'edited',
        origin: 'manual',
        differenceNote: '',
        reviewRequired: false,
        confirmation: null,
      },
    };
  }
  const opening = {
    projectId,
    clientMutationId: randomUUID(),
    materialItemId,
    materialKey: mapping.materialKey,
    specification: mapping.specification,
    unit: 'set',
    workPackageId: packageId,
    scopeVersion: '1',
    ownership: 'TEST',
    custody: 'TEST',
    location: 'TEST',
    openingDate: D1,
    openingCutoffAt: '2035-01-01T00:00:00+01:00',
    openingQuantity: '500',
    openingBasis: 'TEST documented handover',
  };
  const initialized = await expectStatus(
      call('/material-quantity/initialize', pm, opening),
      200,
    ),
    scopeId = initialized.scopeId;
  const view = async (date) =>
    (await material.view(identity, projectId, date)).scopes.find(
      (s) => s.scope.id === scopeId,
    );
  const command = async (date, a, n, issueId = null) => ({
    projectId,
    businessDate: date,
    scopeId,
    expectedVersion: (await view(date)).scope.version,
    clientMutationId: randomUUID(),
    records: [
      {
        sourceBusinessDate: date,
        revisionNumber: n,
        useFactId: a.use.id,
        issueId,
        dueAt: null,
      },
    ],
  });
  const admit = async (c) =>
    expectStatus(call('/material-quantity/admit', pm, c), 200);
  const a = activity('100', '100');
  await save(D1, facts(a));
  await submit(D1);
  const originalReports = hash(await revisionRows()),
    c = await command(D1, a, 1);
  const included = await admit(c),
    afterFirst = hash(await ledgerRows());
  assert.deepEqual(await admit(c), included);
  assert.equal(hash(await ledgerRows()), afterFirst);
  assert.equal(hash(await revisionRows()), originalReports);
  await expectStatus(
    call('/material-quantity/admit', pm, { ...c, businessDate: D2 }),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  await expectStatus(
    call('/material-quantity/admit', pm, {
      ...c,
      clientMutationId: randomUUID(),
    }),
    409,
    'VERSION_CONFLICT',
  );
  pass(
    'material replay, changed-key-body refusal and CAS; admission never creates or changes a Revision',
  );

  for (const bearer of [foreignToken, otherProjectToken, reader])
    await expectStatus(
      call('/material-quantity/admit', bearer, {
        ...c,
        clientMutationId: randomUUID(),
      }),
      403,
    );
  await expectStatus(
    call('/material-quantity/admit', pm, {
      ...c,
      projectId: otherProjectId,
      clientMutationId: randomUUID(),
    }),
    403,
  );
  await owner.query(
    `INSERT INTO "ReportItem"(id,"orgId","projectId",kind,key,label,unit,"sortOrder",active,"updatedBy") VALUES($1,$2,$3,'work',$4,'TEST other project work','set',99,true,$5)`,
    [randomUUID(), orgId, otherProjectId, mapping.workItemKey, accountId],
  );
  const foreignIssue = await issueStore.create(otherIdentity, {
    projectId: otherProjectId,
    businessDate: D1,
    clientMutationId: randomUUID(),
    title: 'TEST other project issue',
    category: '',
    escalate: false,
    controlled: false,
    workItemKey: mapping.workItemKey,
    ownerPersonId: personId,
    dueOn: D1,
    note: 'TEST',
  });
  const badIssue = await command(D1, a, 1, foreignIssue.id),
    beforeBad = hash(await ledgerRows());
  await expectStatus(
    call('/material-quantity/admit', pm, badIssue),
    400,
    'INVALID_INPUT',
  );
  assert.equal(hash(await ledgerRows()), beforeBad);
  const rls = await appPool.connect();
  try {
    await rls.query('BEGIN');
    await rls.query(`SELECT set_config('app.org_id',$1,true)`, [otherOrgId]);
    for (const table of [
      'MaterialQuantityScope',
      'MaterialQuantityMovement',
      'MaterialUseAdmission',
    ])
      assert.equal(
        (
          await rls.query(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "orgId"=$1`,
            [orgId],
          )
        ).rows[0].n,
        0,
      );
  } finally {
    await rls.query('ROLLBACK');
    rls.release();
  }
  const login = (
    await appPool.query(
      `SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
    )
  ).rows[0];
  assert.equal(login.rolsuper, false);
  assert.equal(login.rolbypassrls, false);
  pass(
    'material non-owner RLS, cross-tenant/project writes, reader denial and cross-project Issue rejection',
  );

  const move = (
    await owner.query(
      `SELECT id FROM "MaterialQuantityMovement" WHERE "scopeId"=$1 LIMIT 1`,
      [scopeId],
    )
  ).rows[0];
  for (const sql of [
    `UPDATE "MaterialQuantityMovement" SET quantity=999 WHERE id=$1`,
    `DELETE FROM "MaterialQuantityMovement" WHERE id=$1`,
  ])
    await assert.rejects(
      owner.query(sql, [move.id]),
      (e) => e.code === '23514',
    );
  const config = (
    await owner.query(
      `SELECT proconfig FROM pg_proc WHERE proname='material_movement_immutable'`,
    )
  ).rows;
  assert.equal(config.length, 1);
  assert.ok(
    config[0].proconfig.includes('search_path=pg_catalog, public, pg_temp'),
  );
  pass(
    'material movements remain immutable even for owner; applied trigger function pins search_path',
  );

  const b = activity('50', '50');
  await save(D3, facts(b));
  await submit(D3);
  await admit(await command(D3, b, 1));
  assert.equal((await view(D3)).current.complete, false);
  assert.equal((await view(D3)).current.pendingCount, 1);
  const frozen = (await material.view(identity, projectId, D3, 1)).frozen.find(
    (x) => x.scopeId === scopeId,
  );
  assert.equal(frozen.complete, false);
  assert.ok(frozen.pendingCount >= 1);
  const zero = parseFacts(blankFacts());
  zero.qty.testMaterialOutput = '0';
  zero.materials.testMaterialMount = '0';
  zero.narrative.construction = 'TEST explicit no use';
  await save(D2, zero);
  await submit(D2);
  assert.equal((await view(D3)).current.complete, true);
  assert.deepEqual(
    (await material.view(identity, projectId, D3, 1)).frozen.find(
      (x) => x.scopeId === scopeId,
    ),
    frozen,
  );
  pass(
    'material missing intermediate day remains unknown in current/frozen projection; explicit zero fixes only live view',
  );

  let edited = await correction(D1);
  edited.activities[0].quantity = '90';
  edited.qty.testMaterialOutput = '90';
  await save(D1, edited);
  await submit(D1);
  assert.equal((await view(D1)).sources[0].state, 'followupPending');
  assert.equal((await view(D1)).current.complete, false);
  await expectStatus(
    call('/material-quantity/admit', pm, await command(D1, a, 2)),
    400,
    'INVALID_INPUT',
  );
  const issue = await issueStore.create(identity, {
    projectId,
    businessDate: D1,
    clientMutationId: randomUUID(),
    title: 'TEST unexplained +10',
    category: '',
    escalate: false,
    controlled: false,
    workItemKey: mapping.workItemKey,
    ownerPersonId: personId,
    dueOn: D1,
    note: 'TEST',
  });
  const moveCount = (await ledgerRows()).moves.length;
  await admit(await command(D1, a, 2, issue.id));
  assert.equal((await ledgerRows()).moves.length, moveCount);
  assert.equal((await view(D1)).sources[0].issueId, issue.id);
  assert.equal((await view(D1)).current.complete, true);
  assert.equal((await view(D1)).followups[0].dueAt, null);
  assert.equal((await view(D1)).followups[0].dueOn, D1);
  const readerView = await expectStatus(
    call(
      `/material-quantity?projectId=${projectId}&businessDate=${D1}`,
      reader,
    ),
    200,
  );
  assert.equal(
    readerView.scopes.find((s) => s.scope.id === scopeId).followups[0].issueId,
    issue.id,
  );
  await issueStore.close(identity, {
    issueId: issue.id,
    businessDate: D1,
    expectedVersion: issue.version,
    clientMutationId: randomUUID(),
  });
  assert.equal((await view(D1)).sources[0].state, 'followupPending');
  assert.equal((await view(D1)).current.complete, false);
  pass(
    'same-quantity output correction links current owner/deadline without another deduction; closed followup becomes pending',
  );

  edited = await correction(D1);
  const originalDraft = structuredClone(edited),
    ledgerBefore = hash(await ledgerRows()),
    reportsBefore = hash(await revisionRows());
  const forbidden = [
    () => {
      edited.activities = [];
    },
    () => {
      edited.activities[0].workPackageId = 'TEST-other';
      edited.activities[0].use.estimate = null;
    },
    () => {
      edited.activities[0].scopeVersion = '2';
      edited.activities[0].use.estimate = null;
    },
    () => {
      edited.activities[0].use.specification = 'TEST-other';
      edited.activities[0].use.estimate = null;
    },
    () => {
      edited.activities[0].use.materialItemId = randomUUID();
      edited.activities[0].use.estimate = null;
    },
  ];
  for (const change of forbidden) {
    edited = structuredClone(originalDraft);
    change();
    const d = await day(D1);
    await expectStatus(
      call('/facts', pm, {
        projectId,
        businessDate: D1,
        expectedVersion: d.version,
        clientMutationId: randomUUID(),
        facts: edited,
      }),
      400,
      'INVALID_INPUT',
    );
    assert.equal(hash(await ledgerRows()), ledgerBefore);
    assert.equal(hash(await revisionRows()), reportsBefore);
  }
  edited = structuredClone(originalDraft);
  edited.activities[0].use = {
    ...edited.activities[0].use,
    state: 'edited',
    actualQuantity: '75',
    origin: 'manual',
    confirmation: null,
  };
  await save(D1, edited);
  edited = parseFacts(structuredClone((await day(D1)).facts));
  edited.activities[0].use = {
    ...edited.activities[0].use,
    state: 'pending',
    actualQuantity: '',
    confirmation: null,
  };
  await save(D1, edited);
  await submit(D1);
  assert.equal((await view(D1)).sources[0].state, 'reversalPending');
  assert.equal((await view(D1)).current.balance, '400');
  const beforeWithdrawal = hash(await revisionRows());
  await admit(await command(D1, a, 3));
  assert.equal((await view(D1)).current.balance, '500');
  assert.equal((await view(D1)).sources[0].quantity, null);
  assert.equal((await view(D1)).current.complete, false);
  assert.equal(hash(await revisionRows()), beforeWithdrawal);
  assert.equal((await ledgerRows()).moves.length, moveCount + 1);
  pass(
    'activity deletion/material/spec/scope changes refused; declared→edited→pending reverses admitted100 only, snapshots retained',
  );

  edited = await correction(D1);
  edited.activities[0].use = {
    ...edited.activities[0].use,
    state: 'edited',
    origin: 'manual',
    actualQuantity: '80',
    confirmation: null,
    differenceNote: 'TEST explicit correction reason',
  };
  await save(D1, edited);
  await submit(D1);
  await admit(await command(D1, a, 4));
  assert.equal((await view(D1)).current.balance, '420');
  assert.equal((await ledgerRows()).moves.length, moveCount + 2);
  // Emulate a legacy imported/current revision with an out-of-scope use. Never UPDATE a
  // submitted Revision: append a synthetic revision and advance its current pointer.
  const d = await day(D1),
    originalLegacy = parseFacts(structuredClone(d.facts));
  async function appendLegacy(n, legacy) {
    await owner.query(
      `INSERT INTO "Revision"(id,"orgId","updatedAt","updatedBy","revisionNumber","baseRevisionNumber",state,reason,snapshot,"submittedAt","dailyCloseId") SELECT $1,$2,now(),$3,$7,$7-1,'SUBMITTED','TEST legacy unsupported source',jsonb_set(r.snapshot,'{facts}',$4::jsonb),now(),r."dailyCloseId" FROM "Revision" r JOIN "DailyClose" dc ON dc.id=r."dailyCloseId" WHERE dc."projectId"=$5 AND dc."businessDate"=$6::date AND r."revisionNumber"=$7-1`,
      [
        randomUUID(),
        orgId,
        accountId,
        JSON.stringify(legacy),
        projectId,
        D1,
        n,
      ],
    );
    await owner.query(
      `UPDATE "DailyClose" SET "currentRevisionNumber"=$3 WHERE "projectId"=$1 AND "businessDate"=$2::date`,
      [projectId, D1, n],
    );
  }
  const legacy = structuredClone(originalLegacy);
  legacy.activities[0].workPackageId = 'TEST-legacy-mismatch';
  legacy.activities[0].use.estimate = null;
  await appendLegacy(5, legacy);
  assert.equal((await view(D1)).sources[0].state, 'reversalPending');
  assert.equal((await view(D1)).current.complete, false);
  const legacyReports = hash(await revisionRows());
  await admit(await command(D1, a, 5));
  assert.equal((await view(D1)).current.balance, '500');
  assert.equal(hash(await revisionRows()), legacyReports);
  await appendLegacy(6, originalLegacy);
  await admit(await command(D1, a, 6));
  const absent = structuredClone(originalLegacy);
  absent.activities = [];
  await appendLegacy(7, absent);
  assert.equal((await view(D1)).sources[0].state, 'reversalPending');
  assert.equal((await view(D1)).current.complete, false);
  const absentReports = hash(await revisionRows());
  await admit(await command(D1, a, 7));
  assert.equal((await view(D1)).current.balance, '500');
  assert.equal(hash(await revisionRows()), absentReports);
  pass(
    'legacy mismatched or missing source stays pending and can explicitly reverse; old revisions remain immutable',
  );

  const race = activity('20', '20');
  await save(D4, facts(race));
  const reviseB = await correction(D3);
  reviseB.activities[0].use = {
    ...reviseB.activities[0].use,
    state: 'edited',
    origin: 'manual',
    actualQuantity: '40',
    confirmation: null,
    differenceNote: 'TEST race correction',
  };
  await save(D3, reviseB);
  await submit(D3);
  const correctionCommand = await command(D3, b, 2);
  correctionCommand.businessDate = D4;
  const cutBefore = (await view(D4)).current;
  const lock = await owner.connect(),
    key = `${orgId}:material-quantity:${projectId}`;
  let concurrent;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      key,
    ]);
    concurrent = Promise.all([admit(correctionCommand), submit(D4)]);
    void concurrent.catch(() => undefined);
    await waitForLockWaiters(key, 2);
    await lock.query('COMMIT');
    await concurrent;
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    if (concurrent) await concurrent;
  }

  const cutAfter = (await view(D4)).current,
    raceFrozen = (await material.view(identity, projectId, D4, 1)).frozen.find(
      (x) => x.scopeId === scopeId,
    );
  assert.ok(
    [cutBefore.ledgerVersion, cutAfter.ledgerVersion].includes(
      raceFrozen.ledgerVersion,
    ),
  );
  const expected =
    raceFrozen.ledgerVersion === cutBefore.ledgerVersion ? cutBefore : cutAfter;
  assert.equal(raceFrozen.balance, expected.balance);
  assert.equal(
    raceFrozen.admittedUseCumulative,
    expected.admittedUseCumulative,
  );
  assert.equal((await day(D4)).currentRevisionNumber, 1);
  pass(
    'admission/correction vs submit serializes one wholly old/new frozen balance/use/version; no automatic report revision',
  );

  const good = await command(D4, race, 1),
    batchBefore = hash(await ledgerRows());
  await expectStatus(
    call('/material-quantity/admit', pm, {
      ...good,
      records: [
        ...good.records,
        { ...good.records[0], useFactId: randomUUID() },
      ],
    }),
    400,
    'INVALID_INPUT',
  );
  assert.equal(hash(await ledgerRows()), batchBefore);
  pass(
    'invalid second source rolls back a valid first batch admission atomically',
  );
}

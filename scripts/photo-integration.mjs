// Photos (U2.1 rule 8, slice A5) HTTP + database + blob integration test. Synthetic TEST data
// only: every image is generated in code (an 8x8 gradient; metadata written by the test). Runs
// against an isolated database created for this run and its own private container in the local
// Azurite emulator; the application connects with a low-privilege role (no ownership, no RLS
// bypass) exactly as deployed.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
import {
  AlphaStore,
  IssueStore,
  PhotoStore,
  ReportStore,
} from '../packages/domain/dist/index.js';
import {
  exifTiff,
  testHeif,
  testJpeg,
  testPng,
  testWebp,
} from '../packages/testing/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import { AzurePhotoBlobStore } from '../apps/api/dist/photo-blobs.js';

const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import(
  requireApi.resolve('jose')
);
const source = new URL(process.env.DATABASE_URL);
assert.ok(
  ['localhost', '127.0.0.1'].includes(source.hostname),
  'TEST runner only accepts local database',
);
const blobConnection = process.env.BLOB_CONNECTION_STRING ?? '';
assert.match(
  blobConnection,
  /BlobEndpoint=http:\/\/(127\.0\.0\.1|localhost):/,
  'TEST runner only accepts the local blob emulator',
);
const suffix = randomBytes(6).toString('hex');
const database = `mje_photo_test_${suffix}`;
const username = `mje_test_${suffix}`;
const password = randomBytes(24).toString('hex');
const containerName = `evidence-test-${suffix}`;
const admin = new Pool({ connectionString: source.toString() });
// pool.end() resolves before idle sockets finish closing; DROP DATABASE ... WITH (FORCE) can
// then terminate one (57P01) and the pool would re-emit it as an unhandled 'error'. Only that
// shutdown termination is ignored; any other pool error still fails the run.
const tolerateShutdown = (pool) =>
  pool.on('error', (error) => {
    if (error?.code !== '57P01') throw error;
  });
const isolated = new URL(source);
isolated.pathname = `/${database}`;
let owner, appPool, app, blobs;
let dbCreated = false,
  roleCreated = false,
  checks = 0;
const pass = (name) => {
  checks++;
  console.log(`PASS ${name}`);
};
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  dbCreated = true;
  execFileSync('pnpm', ['db:migrate'], {
    env: { ...process.env, DATABASE_URL: isolated.toString() },
    stdio: 'pipe',
  });
  owner = tolerateShutdown(new Pool({ connectionString: isolated.toString() }));
  await admin.query(
    `CREATE ROLE "${username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${username}"`);
  const appUrl = new URL(isolated);
  appUrl.username = username;
  appUrl.password = password;
  appPool = tolerateShutdown(
    new Pool({ connectionString: appUrl.toString(), max: 8 }),
  );

  // ---------- blob store: a private container of this run, every write counted ----------
  blobs = AzurePhotoBlobStore.fromConnectionString(
    blobConnection,
    containerName,
  );
  await blobs.ensureContainer();
  const puts = [];
  // Armed by a test: the next thumbnail write succeeds and then the request fails, as a database
  // error after the blob writes would (the transaction rolls back, both blobs stay).
  let failAfterThumbnailWrite = false;
  const countingBlobs = {
    put: async (key, bytes, contentType) => {
      puts.push(key);
      await blobs.put(key, bytes, contentType);
      if (failAfterThumbnailWrite && key.endsWith('.thumb')) {
        failAfterThumbnailWrite = false;
        throw new Error('TEST failure after the blob writes');
      }
    },
    get: (key) => blobs.get(key),
  };

  // ---------- synthetic TEST tenancy ----------
  // org A: PM of project A; the same person's second account is PM of project A2 only;
  // an org-wide executive. org B: its own PM.
  const tenantId = randomUUID(),
    audience = randomUUID(),
    clientId = randomUUID();
  const orgA = randomUUID(),
    orgB = randomUUID();
  const projectA = randomUUID(),
    projectA2 = randomUUID(),
    projectB = randomUUID();
  const personPm = randomUUID(),
    personExec = randomUUID(),
    personB = randomUUID();
  const accountPm = randomUUID(),
    accountTwin = randomUUID(),
    accountExec = randomUUID(),
    accountB = randomUUID();
  const objectPm = randomUUID(),
    objectTwin = randomUUID(),
    objectExec = randomUUID(),
    objectB = randomUUID();
  const seedActor = randomUUID();
  for (const [orgId, name] of [
    [orgA, 'TEST Organization A'],
    [orgB, 'TEST Organization B'],
  ])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3)',
      [orgId, name, seedActor],
    );
  for (const [id, orgId] of [
    [personPm, orgA],
    [personExec, orgA],
    [personB, orgB],
  ])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,\'TEST Person\')',
      [id, orgId, seedActor],
    );
  for (const [id, orgId, code] of [
    [projectA, orgA, 'TEST-A'],
    [projectA2, orgA, 'TEST-A2'],
    [projectB, orgB, 'TEST-B'],
  ])
    await owner.query(
      'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,$4,\'Europe/Belgrade\',\'ACTIVE\')',
      [id, orgId, seedActor, code],
    );
  for (const [id, orgId, personId, objectId] of [
    [accountPm, orgA, personPm, objectPm],
    [accountTwin, orgA, personPm, objectTwin],
    [accountExec, orgA, personExec, objectExec],
    [accountB, orgB, personB, objectB],
  ])
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [id, orgId, seedActor, tenantId, objectId, personId],
    );
  const membership = (orgId, accountId, role, projectId) =>
    owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now()-interval \'1 hour\',$5,$6)',
      [randomUUID(), orgId, seedActor, role, accountId, projectId],
    );
  await membership(orgA, accountPm, 'PROJECT_MANAGER', projectA);
  await membership(orgA, accountTwin, 'PROJECT_MANAGER', projectA2);
  await membership(orgA, accountExec, 'EXECUTIVE_READER', null);
  await membership(orgB, accountB, 'PROJECT_MANAGER', projectB);

  const keys = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'RS256',
    kid: 'TEST',
  };
  const auth = { tenantId, audience, clientId, scope: 'access_as_user' };
  const verifier = new TokenVerifier(auth, createLocalJWKSet({ keys: [jwk] }));
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    reportStore: new ReportStore(appPool),
    issueStore: new IssueStore(appPool),
    photoStore: new PhotoStore(appPool, countingBlobs),
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function token(oid) {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      tid: tenantId,
      oid,
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
      sub: 'TEST-subject',
      iat: now,
      nbf: now - 1,
      exp: now + 600,
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: audience,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST' })
      .sign(keys.privateKey);
  }
  const pm = await token(objectPm),
    twin = await token(objectTwin),
    exec = await token(objectExec),
    pmB = await token(objectB);
  const responses = [];
  async function call(path, bearer, body, idempotencyKey) {
    const response = await fetch(base + '/api/report' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey ?? body.clientMutationId,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: JSON.parse(text) };
  }
  /** Multipart upload; `fields` are strings, `photo`/`thumbnail` are { bytes, type }. */
  async function upload(bearer, fields, photo, thumbnail, idempotencyKey) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields))
      if (v !== undefined) form.append(k, v);
    if (photo)
      form.append('photo', new Blob([photo.bytes], { type: photo.type }), 'p');
    if (thumbnail)
      form.append(
        'thumbnail',
        new Blob([thumbnail.bytes], { type: thumbnail.type }),
        't',
      );
    const response = await fetch(base + '/api/report/photos', {
      method: 'POST',
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        'Idempotency-Key': idempotencyKey ?? fields.clientMutationId,
      },
      body: form,
    });
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: JSON.parse(text) };
  }
  async function raw(path, bearer) {
    const response = await fetch(base + '/api/report/photos' + path, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      cache: response.headers.get('cache-control'),
      bytes,
      json: response.headers.get('content-type')?.startsWith('application/json')
        ? JSON.parse(bytes.toString())
        : null,
    };
  }
  const expectStatus = async (promise, status, code) => {
    const r = await promise;
    assert.equal(r.status, status, JSON.stringify(r.body));
    if (code) assert.equal(r.body.code, code);
    return r.body;
  };
  const count = async (sql, params = []) =>
    (await owner.query(sql, params)).rows[0].n;
  const photoRows = () =>
    count('SELECT count(*)::int AS n FROM "PhotoEvidence"');
  const audits = (action) =>
    count('SELECT count(*)::int AS n FROM "AuditLog" WHERE action=$1', [
      action,
    ]);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const D1 = '2026-10-05',
    D2 = '2026-10-06',
    D3 = '2026-10-07';
  const key = () => randomUUID();
  const fix = {
    lat: '44.800000',
    lon: '20.400000',
    accuracyM: '12',
    fixAt: '2026-10-05T08:00:00Z',
  };
  const camera = (over = {}) => ({
    projectId: projectA,
    businessDate: D1,
    clientMutationId: key(),
    source: 'camera',
    ...fix,
    takenAt: '2026-10-05T08:00:02Z',
    ...over,
  });
  const album = (over = {}) => ({
    projectId: projectA,
    businessDate: D1,
    clientMutationId: key(),
    source: 'album',
    ...over,
  });
  const jpeg = (tag, exif) => ({
    bytes: testJpeg({ tag, ...(exif ? { exif } : {}) }),
    type: 'image/jpeg',
  });
  const list = (date, bearer = pm, projectId = projectA) =>
    call(`/photos?projectId=${projectId}&businessDate=${date}`, bearer);
  const day = (date, bearer = pm) =>
    call(`/day?projectId=${projectA}&businessDate=${date}`, bearer);

  await expectStatus(
    call('/items', pm, {
      projectId: projectA,
      clientMutationId: key(),
      items: [
        { kind: 'work', key: 'support', label: 'TEST support', unit: 'set' },
        { kind: 'work', key: 'rail', label: 'TEST rail', unit: 'm' },
        { kind: 'work', key: 'retired', label: 'TEST old', active: false },
        { kind: 'machinery', key: 'crane', label: 'TEST crane' },
      ],
    }),
    200,
  );
  const issue = await expectStatus(
    call('/issues', pm, {
      projectId: projectA,
      businessDate: D1,
      clientMutationId: key(),
      title: 'TEST cable tray damaged',
    }),
    200,
  );
  const issueB = await expectStatus(
    call('/issues', pmB, {
      projectId: projectB,
      businessDate: D1,
      clientMutationId: key(),
      title: 'TEST other org issue',
    }),
    200,
  );

  // ---------- rule 8: in-app capture needs a device fix ----------
  assert.equal(
    (await upload(null, camera(), jpeg('anon'))).status,
    401,
    'unauthenticated upload',
  );
  for (const fields of [
    {
      ...camera(),
      lat: undefined,
      lon: undefined,
      accuracyM: undefined,
      fixAt: undefined,
    },
    camera({ fixAt: undefined }),
    camera({ accuracyM: undefined }),
    camera({ lat: '91' }),
    camera({ lon: '-180.5' }),
  ])
    await expectStatus(
      upload(pm, fields, jpeg('nofix')),
      409,
      'NEEDS_LOCATION',
    );
  for (const [k, v] of [
    ['lat', '44.8000001'],
    ['fixAt', 'yesterday'],
    ['accuracyM', '-3'],
  ])
    await expectStatus(
      upload(pm, camera({ [k]: v }), jpeg('bad')),
      400,
      'INVALID_INPUT',
    );
  assert.equal(await photoRows(), 0);
  assert.equal(puts.length, 0);
  pass(
    'camera upload without a fix, without its time or accuracy, or off the globe is refused (409 NEEDS_LOCATION); malformed fix fields 400; nothing stored, no blob written',
  );

  // ---------- media: declared type must match the bytes; size limits ----------
  const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);
  testJpeg().copy(tooBig);
  for (const [photo, status, code] of [
    [
      { bytes: testJpeg({ tag: 'g' }), type: 'image/gif' },
      415,
      'UNSUPPORTED_MEDIA',
    ],
    [
      { bytes: testJpeg({ tag: 'm' }), type: 'image/png' },
      415,
      'UNSUPPORTED_MEDIA',
    ],
    [
      { bytes: Buffer.from('TEST not an image'), type: 'image/jpeg' },
      415,
      'UNSUPPORTED_MEDIA',
    ],
    [
      {
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        type: 'image/svg+xml',
      },
      415,
      'UNSUPPORTED_MEDIA',
    ],
    [
      { bytes: testHeif({ brand: 'avif' }), type: 'image/heif' },
      415,
      'UNSUPPORTED_MEDIA',
    ],
    [{ bytes: Buffer.alloc(0), type: 'image/jpeg' }, 415, 'UNSUPPORTED_MEDIA'],
    [{ bytes: tooBig, type: 'image/jpeg' }, 413, 'PHOTO_TOO_LARGE'],
  ])
    await expectStatus(upload(pm, camera(), photo), status, code);
  const bigThumb = Buffer.alloc(300 * 1024 + 1);
  testJpeg().copy(bigThumb);
  await expectStatus(
    upload(pm, camera(), jpeg('t1'), { bytes: bigThumb, type: 'image/jpeg' }),
    413,
    'PHOTO_TOO_LARGE',
  );
  await expectStatus(
    upload(pm, camera(), jpeg('t2'), { bytes: testHeif(), type: 'image/heic' }),
    415,
    'UNSUPPORTED_MEDIA',
  );
  await expectStatus(upload(pm, camera(), null), 400, 'INVALID_INPUT');
  await expectStatus(
    upload(pm, { ...camera(), orgId: orgB }, jpeg('extra')),
    400,
    'INVALID_INPUT',
  );
  assert.equal(await photoRows(), 0);
  assert.equal(puts.length, 0);
  pass(
    'wrong declared type, magic-byte mismatch, non-image, SVG, AVIF, empty file 415; photo > 10 MB and thumbnail > 300 KB 413; HEIF thumbnail 415; missing photo or unknown field 400; nothing stored',
  );

  // ---------- camera capture with fix, link and thumbnail; bytes round-trip through Azurite ----------
  const shot1 = jpeg('shot-1');
  const thumb1 = { bytes: testPng({ tag: 'thumb-1' }), type: 'image/png' };
  const firstUpload = camera({ workItemKey: 'support' });
  const p1 = await expectStatus(upload(pm, firstUpload, shot1, thumb1), 200);
  assert.equal(p1.deduplicated, false);
  assert.equal(p1.source, 'camera');
  assert.equal(p1.location, 'device');
  assert.deepEqual(p1.capture, {
    lat: '44.800000',
    lon: '20.400000',
    accuracyM: '12.00',
    fixAt: '2026-10-05T08:00:00.000Z',
  });
  assert.equal(p1.deviceCapturedAt, '2026-10-05T08:00:02.000Z');
  assert.deepEqual(p1.link, { type: 'item', id: 'support' });
  assert.equal(p1.linkVersion, 1);
  assert.equal(p1.sha256, sha(shot1.bytes));
  assert.equal(p1.sizeBytes, shot1.bytes.length);
  assert.equal(p1.hasThumbnail, true);
  assert.equal(p1.uploadedByPersonId, personPm);
  assert.equal(p1.businessDate, D1);
  assert.deepEqual(puts, [
    `${orgA}/${p1.sha256}`,
    `${orgA}/${sha(thumb1.bytes)}.thumb`,
  ]);
  const got = await raw(`/${p1.id}`, pm);
  assert.equal(got.status, 200);
  assert.equal(got.type, 'image/jpeg');
  assert.equal(got.cache, 'no-store');
  assert.ok(got.bytes.equals(shot1.bytes));
  const gotThumb = await raw(`/${p1.id}/thumbnail`, pm);
  assert.equal(gotThumb.status, 200);
  assert.equal(gotThumb.type, 'image/png');
  assert.ok(gotThumb.bytes.equals(thumb1.bytes));
  // The container is private: the blob itself is not reachable without the API.
  const endpoint = /BlobEndpoint=([^;]+)/
    .exec(blobConnection)[1]
    .replace(/\/$/, '');
  const anonymous = await fetch(
    `${endpoint}/${containerName}/${orgA}/${p1.sha256}`,
  );
  assert.notEqual(anonymous.status, 200);
  await anonymous.arrayBuffer();
  const meta = await expectStatus(call(`/photos/${p1.id}/meta`, pm), 200);
  const p1View = { ...p1 };
  delete p1View.deduplicated;
  assert.deepEqual(meta, { access: 'write', photo: p1View });
  pass(
    'camera photo with device fix, device time, work-item link and client thumbnail stored (content-addressed keys); photo and thumbnail bytes read back unchanged through the API (no-store); the private container refuses anonymous reads',
  );

  // ---------- exactly once: replay, reused key, duplicate bytes ----------
  const uploadsBefore = await audits('PHOTO_UPLOAD');
  assert.equal(uploadsBefore, 1);
  assert.deepEqual(await upload(pm, firstUpload, shot1, thumb1), {
    status: 200,
    body: p1,
  });
  await expectStatus(
    upload(pm, firstUpload, jpeg('other-bytes')),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  await expectStatus(
    upload(pm, camera(), jpeg('mismatch'), null, randomUUID()),
    400,
    'INVALID_INPUT',
  );
  const dup = await expectStatus(
    upload(pm, album(), { bytes: shot1.bytes, type: 'image/jpeg' }),
    200,
  );
  assert.equal(dup.id, p1.id);
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.source, 'camera', 'the first record stands');
  assert.deepEqual(dup.link, p1.link);
  assert.equal(await photoRows(), 1);
  assert.equal(puts.length, 2, 'no second blob write');
  assert.equal(await audits('PHOTO_UPLOAD'), 1, 'no second upload audit');
  assert.equal(await audits('PHOTO_LINK'), 0);
  // The same file is one fact: never copied to another day or project.
  await expectStatus(
    upload(pm, camera({ businessDate: D2 }), shot1),
    409,
    'PHOTO_ELSEWHERE',
  );
  assert.equal(await photoRows(), 1);
  pass(
    'a replay returns the stored body; a reused key with other bytes 409; mismatched Idempotency-Key 400; the same bytes under a new key return the same photo with no second row, blob write or audit; the same bytes for another day 409 PHOTO_ELSEWHERE',
  );

  // ---------- a duplicate never changes links (delayed retry after an unlink) ----------
  const q = jpeg('delayed');
  const q1 = await expectStatus(
    upload(pm, album({ businessDate: D3, workItemKey: 'support' }), q),
    200,
  );
  assert.equal(q1.linkVersion, 1);
  const qUnlinked = await expectStatus(
    call('/photos/unlink', pm, {
      photoId: q1.id,
      clientMutationId: key(),
      expectedVersion: 1,
    }),
    200,
  );
  assert.equal(qUnlinked.linkVersion, 2);
  const linkAudits = await audits('PHOTO_LINK');
  const qLate = await expectStatus(
    upload(pm, album({ businessDate: D3, workItemKey: 'rail' }), q),
    200,
  );
  assert.equal(qLate.id, q1.id);
  assert.equal(qLate.deduplicated, true);
  assert.equal(qLate.link, null, 'the unlink stands');
  assert.equal(qLate.linkVersion, 2);
  assert.equal(await audits('PHOTO_LINK'), linkAudits);
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "EvidenceLink" WHERE "photoId"=$1',
      [q1.id],
    ),
    1,
  );
  pass(
    'a delayed duplicate upload carrying a link after the photo was unlinked returns the photo unchanged: no link, same link version, no link row or audit (links change only through link/unlink with expectedVersion)',
  );

  // ---------- blobs left by a rolled-back upload cannot poison a retry ----------
  const rolled = jpeg('rolled-back');
  const rowsBeforeFailure = await photoRows();
  console.log(
    'NOTE the next two request_failed log lines are the injected TEST failures',
  );
  failAfterThumbnailWrite = true;
  const failed = await upload(pm, album({ businessDate: D3 }), rolled, {
    bytes: testPng({ tag: 'thumb-a' }),
    type: 'image/png',
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, 'REQUEST_FAILED');
  assert.equal(await photoRows(), rowsBeforeFailure);
  assert.ok(await blobs.get(`${orgA}/${sha(rolled.bytes)}`), 'orphan photo');
  const thumbB = { bytes: testWebp({ tag: 'thumb-b' }), type: 'image/webp' };
  const retried = await expectStatus(
    upload(pm, album({ businessDate: D3 }), rolled, thumbB),
    200,
  );
  assert.equal(retried.deduplicated, false);
  const retriedThumb = await raw(`/${retried.id}/thumbnail`, pm);
  assert.equal(retriedThumb.status, 200);
  assert.equal(retriedThumb.type, 'image/webp');
  assert.ok(retriedThumb.bytes.equals(thumbB.bytes));
  assert.ok((await raw(`/${retried.id}`, pm)).bytes.equals(rolled.bytes));
  const thumbRow = await owner.query(
    'SELECT "thumbBlobKey", "thumbSha256" FROM "PhotoEvidence" WHERE id=$1',
    [retried.id],
  );
  assert.deepEqual(thumbRow.rows[0], {
    thumbBlobKey: `${orgA}/${sha(thumbB.bytes)}.thumb`,
    thumbSha256: sha(thumbB.bytes),
  });
  // An object under a photo's key that does not hold those bytes is refused, never overwritten.
  const tampered = jpeg('tampered');
  const tamperedKey = `${orgA}/${sha(tampered.bytes)}`;
  await blobs.put(tamperedKey, testJpeg({ tag: 'other' }), 'image/jpeg');
  const refused = await upload(pm, album({ businessDate: D3 }), tampered);
  assert.equal(refused.status, 500);
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "PhotoEvidence" WHERE sha256=$1',
      [sha(tampered.bytes)],
    ),
    0,
  );
  assert.ok(
    (await blobs.get(tamperedKey)).bytes.equals(testJpeg({ tag: 'other' })),
  );
  pass(
    'after a failure behind the blob writes, a retry with another thumbnail (other bytes and type) stores and serves the new one (thumbnails are addressed by their own sha256; the orphan photo blob is verified and reused); an existing object that does not hold the bytes its key names is refused and left untouched',
  );

  // ---------- album: only what the file says; never the uploader position ----------
  const noGps = await expectStatus(
    upload(pm, album(), {
      bytes: testPng({ tag: 'album-plain' }),
      type: 'image/png',
    }),
    200,
  );
  assert.equal(noGps.location, 'none');
  assert.equal(noGps.capture, null);
  assert.deepEqual(noGps.file, { takenLocal: null, takenAt: null, gps: null });
  assert.equal(noGps.link, null);
  assert.equal(noGps.linkVersion, 0);
  assert.equal(noGps.hasThumbnail, false);
  const exif = exifTiff({
    dateTimeOriginal: '2026:10:05 11:20:00',
    offsetTimeOriginal: '+02:00',
    gps: {
      latRef: 'N',
      lat: [
        [44, 1],
        [48, 1],
        [0, 1],
      ],
      lonRef: 'E',
      lon: [
        [20, 1],
        [24, 1],
        [3600, 100],
      ],
    },
  });
  const withGps = await expectStatus(
    upload(pm, album({ issueId: issue.id }), jpeg('album-gps', exif)),
    200,
  );
  assert.equal(withGps.location, 'file');
  assert.equal(withGps.capture, null);
  assert.deepEqual(withGps.file, {
    takenLocal: '2026-10-05T11:20:00',
    takenAt: '2026-10-05T09:20:00.000Z',
    gps: { lat: '44.800000', lon: '20.410000' },
  });
  assert.deepEqual(withGps.link, { type: 'issue', id: issue.id });
  const heif = await expectStatus(
    upload(pm, album(), {
      bytes: testHeif({
        exif: exifTiff({ dateTimeOriginal: '2026:10:05 12:00:00' }),
        tag: 'heif',
      }),
      type: 'image/heic',
    }),
    200,
  );
  assert.deepEqual(heif.file, {
    takenLocal: '2026-10-05T12:00:00',
    takenAt: null,
    gps: null,
  });
  const webp = await expectStatus(
    upload(pm, album(), {
      bytes: testWebp({ tag: 'webp' }),
      type: 'image/webp',
    }),
    200,
  );
  assert.equal(webp.location, 'none');
  // A camera capture never takes the file's GPS, only its fix.
  const cameraWithFileGps = await expectStatus(
    upload(pm, camera(), jpeg('camera-file-gps', exif)),
    200,
  );
  assert.equal(cameraWithFileGps.location, 'device');
  assert.equal(cameraWithFileGps.file.gps, null);
  assert.equal(cameraWithFileGps.file.takenLocal, '2026-10-05T11:20:00');
  for (const extra of [fix, { takenAt: '2026-10-05T08:00:00Z' }])
    await expectStatus(
      upload(pm, album(extra), jpeg('album-fix')),
      400,
      'INVALID_INPUT',
    );
  const stored = await owner.query(
    'SELECT "captureLat", "captureFixAt", "deviceCapturedAt", "fileGpsLat" FROM "PhotoEvidence" WHERE id=$1',
    [noGps.id],
  );
  assert.deepEqual(stored.rows[0], {
    captureLat: null,
    captureFixAt: null,
    deviceCapturedAt: null,
    fileGpsLat: null,
  });
  pass(
    'album photo without GPS accepted and flagged "none"; album EXIF time (with offset → instant, without → local only) and GPS kept as file claims (JPEG, HEIF, WebP); a camera photo ignores the file GPS; an album upload carrying an uploader fix or device time 400',
  );

  // ---------- links: targets, versions, append-only history ----------
  await expectStatus(
    upload(pm, album({ workItemKey: 'retired' }), jpeg('retired')),
    409,
    'ITEM_NOT_FOUND',
  );
  for (const [link, code] of [
    [{ type: 'item', id: 'nope' }, 'ITEM_NOT_FOUND'],
    [{ type: 'item', id: 'crane' }, 'ITEM_NOT_FOUND'],
    [{ type: 'issue', id: issueB.id }, 'ISSUE_NOT_FOUND'],
    [{ type: 'issue', id: randomUUID() }, 'ISSUE_NOT_FOUND'],
  ])
    await expectStatus(
      call('/photos/link', pm, {
        photoId: noGps.id,
        clientMutationId: key(),
        expectedVersion: 0,
        link,
      }),
      409,
      code,
    );
  const linkCmd = {
    photoId: noGps.id,
    clientMutationId: key(),
    expectedVersion: 0,
    link: { type: 'item', id: 'rail' },
  };
  const linked = await expectStatus(call('/photos/link', pm, linkCmd), 200);
  assert.deepEqual(linked.link, { type: 'item', id: 'rail' });
  assert.equal(linked.linkVersion, 1);
  assert.deepEqual(await call('/photos/link', pm, linkCmd), {
    status: 200,
    body: linked,
  });
  await expectStatus(
    call('/photos/link', pm, { ...linkCmd, clientMutationId: key() }),
    409,
    'VERSION_CONFLICT',
  );
  await expectStatus(
    call('/photos/link', exec, {
      ...linkCmd,
      clientMutationId: key(),
      expectedVersion: 1,
    }),
    403,
    'READ_ONLY',
  );
  await expectStatus(
    call('/photos/link', twin, {
      ...linkCmd,
      clientMutationId: key(),
      expectedVersion: 1,
    }),
    403,
    'FORBIDDEN',
  );
  await expectStatus(
    call('/photos/link', pmB, {
      ...linkCmd,
      clientMutationId: key(),
      expectedVersion: 1,
    }),
    404,
    'NOT_FOUND',
  );
  const unlinked = await expectStatus(
    call('/photos/unlink', pm, {
      photoId: noGps.id,
      clientMutationId: key(),
      expectedVersion: 1,
    }),
    200,
  );
  assert.equal(unlinked.link, null);
  assert.equal(unlinked.linkVersion, 2);
  await expectStatus(
    call('/photos/unlink', pm, {
      photoId: noGps.id,
      clientMutationId: key(),
      expectedVersion: 2,
    }),
    409,
    'NOT_LINKED',
  );
  const relinked = await expectStatus(
    call('/photos/link', pm, {
      photoId: noGps.id,
      clientMutationId: key(),
      expectedVersion: 2,
      link: { type: 'issue', id: issue.id },
    }),
    200,
  );
  assert.equal(relinked.linkVersion, 3);
  const history = await owner.query(
    `SELECT "workItemKey", "issueId", "supersededAt" IS NOT NULL AS superseded, "supersededBy" FROM "EvidenceLink"
    WHERE "photoId"=$1 ORDER BY seq`,
    [noGps.id],
  );
  assert.deepEqual(history.rows, [
    {
      workItemKey: 'rail',
      issueId: null,
      superseded: true,
      supersededBy: accountPm,
    },
    {
      workItemKey: null,
      issueId: issue.id,
      superseded: false,
      supersededBy: null,
    },
  ]);
  // Racing link changes from the same version: exactly one wins.
  const race = await Promise.all(
    [
      { type: 'item', id: 'support' },
      { type: 'item', id: 'rail' },
    ].map((link) =>
      call('/photos/link', pm, {
        photoId: noGps.id,
        clientMutationId: key(),
        expectedVersion: 3,
        link,
      }),
    ),
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    race.find((r) => r.status === 409).body.code,
    'VERSION_CONFLICT',
  );
  const winner = race.find((r) => r.status === 200).body;
  assert.equal(winner.linkVersion, 5);
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "EvidenceLink" WHERE "photoId"=$1 AND "supersededAt" IS NULL',
      [noGps.id],
    ),
    1,
  );
  pass(
    'links need an active work item or a site issue of the same project (409 otherwise); link/unlink are exactly once and versioned (stale 409, racing changes: one wins); executive 403 READ_ONLY, another project 403, another org 404; unlinking nothing 409; history is append-only (superseded rows kept, one current link)',
  );

  // ---------- read access: the project's readers; nobody else ----------
  // OD18: before a submission a reader gets none of the day's photos; each is not found.
  const execList = await expectStatus(list(D1, exec), 200);
  assert.equal(execList.access, 'read');
  assert.deepEqual(execList.photos, []);
  assert.equal(execList.unlinkedPhotos, 0);
  const notFoundForReader = async (id) => {
    for (const suffix of ['', '/thumbnail', '/meta']) {
      const r = await raw(`/${id}${suffix}`, exec);
      assert.equal(r.status, 404, `${id}${suffix}`);
      assert.equal(r.json.code, 'NOT_FOUND');
    }
  };
  await notFoundForReader(p1.id);
  assert.deepEqual((await expectStatus(day(D1, exec), 200)).photos, []);
  // The project manager's reads are unchanged.
  const pmList = await expectStatus(list(D1), 200);
  assert.equal(pmList.access, 'write');
  assert.equal(pmList.photos.length, 6);
  // heif, webp and cameraWithFileGps have no link yet.
  assert.equal(pmList.unlinkedPhotos, 3);
  assert.equal((await raw(`/${p1.id}`, pm)).status, 200);
  assert.equal((await raw(`/${p1.id}/thumbnail`, pm)).status, 200);
  await expectStatus(list(D1, twin), 403, 'FORBIDDEN');
  await expectStatus(list(D1, pmB), 403, 'FORBIDDEN');
  for (const [bearer, status] of [
    [twin, 403],
    [pmB, 404],
    [null, 401],
  ]) {
    assert.equal((await raw(`/${p1.id}`, bearer)).status, status);
    assert.equal((await raw(`/${p1.id}/thumbnail`, bearer)).status, status);
  }
  assert.equal((await raw(`/${noGps.id}/thumbnail`, pm)).status, 404);
  assert.equal((await raw(`/${randomUUID()}`, pm)).status, 404);
  assert.equal((await raw('/not-an-id', pm)).status, 400);
  await expectStatus(upload(exec, album(), jpeg('exec')), 403, 'READ_ONLY');
  await expectStatus(upload(twin, album(), jpeg('twin')), 403, 'FORBIDDEN');
  await expectStatus(upload(pmB, album(), jpeg('org-b')), 403, 'FORBIDDEN');
  await expectStatus(
    upload(pm, album({ projectId: projectB }), jpeg('project-b')),
    403,
    'FORBIDDEN',
  );
  pass(
    "before any submission the executive gets an empty list and 404 NOT_FOUND for photo, thumbnail and metadata (OD18) while the PM reads them; writes by the executive (READ_ONLY), the same person's other-project account, another org's PM or into another org's project are refused; other project 403, other org 404, anonymous 401; missing thumbnail or photo 404",
  );

  // ---------- coverage and the frozen snapshot (rules 1, 5) ----------
  // Current links: p1 → support (camera); noGps → winner of the race; withGps → issue.
  await expectStatus(
    call('/facts', pm, {
      projectId: projectA,
      businessDate: D1,
      expectedVersion: 0,
      clientMutationId: key(),
      facts: {
        weather: 'TEST',
        temperature: '',
        qty: { support: '4', rail: '12', retired: '' },
        cumulative: { support: '4', rail: '12' },
        narrative: { construction: 'TEST', quality: 'TEST', safety: 'TEST' },
        people: { manager: '1' },
        presence: {},
        machinery: { crane: '1' },
        materials: {},
        milestones: {},
        noWork: null,
        updated: {},
      },
    }),
    200,
  );
  // Put rail on the camera photo and noGps on support, so rail's reminder depends on one link.
  const noGpsNow = (await expectStatus(list(D1), 200)).photos.find(
    (p) => p.id === noGps.id,
  );
  const toSupport =
    noGpsNow.link?.id === 'support'
      ? noGpsNow
      : await expectStatus(
          call('/photos/link', pm, {
            photoId: noGps.id,
            clientMutationId: key(),
            expectedVersion: noGpsNow.linkVersion,
            link: { type: 'item', id: 'support' },
          }),
          200,
        );
  let view = await expectStatus(day(D1), 200);
  const photoMissing = (v) =>
    v.coverage.missing.filter((m) => m.key === 'photo').map((m) => m.item);
  assert.deepEqual(photoMissing(view), ['rail']);
  assert.equal(view.photos.length, 6);
  const railLink = await expectStatus(
    call('/photos/link', pm, {
      photoId: cameraWithFileGps.id,
      clientMutationId: key(),
      expectedVersion: 0,
      link: { type: 'item', id: 'rail' },
    }),
    200,
  );
  view = await expectStatus(day(D1), 200);
  assert.deepEqual(photoMissing(view), []);
  // heif and webp are unlinked: the day shows them so the UI can prompt before submitting.
  assert.equal(view.unlinkedPhotos, 2);
  assert.equal(view.photos.length, 6);
  const submitted = await expectStatus(
    call('/submit', pm, {
      projectId: projectA,
      businessDate: D1,
      expectedVersion: view.version,
      clientMutationId: key(),
    }),
    200,
  );
  assert.equal(submitted.revisionNumber, 1);
  assert.deepEqual(photoMissing(submitted), []);
  const rev = (n) =>
    call(`/revision?projectId=${projectA}&businessDate=${D1}&n=${n}`, pm);
  const rev1 = await expectStatus(rev(1), 200);
  const frozen = Object.fromEntries(rev1.snapshot.photos.map((p) => [p.id, p]));
  // Unlinked photos are staging only: the revision takes the 4 linked ones.
  assert.deepEqual(
    rev1.snapshot.photos.map((p) => p.id).sort(),
    [p1.id, noGps.id, withGps.id, cameraWithFileGps.id].sort(),
  );
  assert.ok(rev1.snapshot.photos.every((p) => p.link !== null));
  assert.deepEqual(frozen[p1.id], {
    id: p1.id,
    source: 'camera',
    location: 'device',
    accuracyM: '12.00',
    deviceCapturedAt: '2026-10-05T08:00:02.000Z',
    fileTakenAt: null,
    fileTakenLocal: null,
    link: { type: 'item', id: 'support' },
  });
  assert.deepEqual(frozen[cameraWithFileGps.id].link, {
    type: 'item',
    id: 'rail',
  });
  assert.equal(frozen[noGps.id].location, 'none');
  assert.equal(frozen[withGps.id].location, 'file');
  assert.equal(frozen[withGps.id].fileTakenAt, '2026-10-05T09:20:00.000Z');
  assert.ok(!JSON.stringify(rev1.snapshot.photos).includes('44.8'));
  // Rule 1: relinking after submission is allowed and never reaches the revision.
  const after = await expectStatus(
    call('/photos/link', pm, {
      photoId: cameraWithFileGps.id,
      clientMutationId: key(),
      expectedVersion: railLink.linkVersion,
      link: { type: 'issue', id: issue.id },
    }),
    200,
  );
  assert.deepEqual(after.link, { type: 'issue', id: issue.id });
  // A photo left unlinked at submission can still be linked; the revision does not change.
  await expectStatus(
    call('/photos/link', pm, {
      photoId: heif.id,
      clientMutationId: key(),
      expectedVersion: 0,
      link: { type: 'item', id: 'support' },
    }),
    200,
  );
  assert.deepEqual(await expectStatus(rev(1), 200), rev1);
  view = await expectStatus(day(D1), 200);
  assert.equal(view.state, 'submitted');
  assert.deepEqual(photoMissing(view), ['rail']);
  assert.equal(view.unlinkedPhotos, 1);
  assert.deepEqual(
    view.photos.find((p) => p.id === cameraWithFileGps.id).link,
    { type: 'issue', id: issue.id },
  );
  // OD18: a reader gets the 4 frozen photos with the link each had at submission.
  const ids = (photos) => photos.map((p) => p.id);
  const execFrozen = await expectStatus(list(D1, exec), 200);
  assert.deepEqual(ids(execFrozen.photos), ids(rev1.snapshot.photos));
  assert.equal(execFrozen.unlinkedPhotos, 0);
  assert.deepEqual(
    execFrozen.photos.find((p) => p.id === cameraWithFileGps.id).link,
    { type: 'item', id: 'rail' },
  );
  assert.ok(execFrozen.photos.every((p) => p.linkVersion === 0));
  const execDay = await expectStatus(day(D1, exec), 200);
  assert.equal(execDay.version, 0);
  assert.deepEqual(execDay.photos, execFrozen.photos);
  assert.equal(execDay.unlinkedPhotos, 0);
  assert.equal((await raw(`/${p1.id}`, exec)).status, 200);
  assert.equal((await raw(`/${p1.id}/thumbnail`, exec)).status, 200);
  const execMeta = await expectStatus(
    call(`/photos/${cameraWithFileGps.id}/meta`, exec),
    200,
  );
  assert.deepEqual(execMeta.photo.link, { type: 'item', id: 'rail' });
  // heif was linked only after the submission, webp never: not found for the reader.
  await notFoundForReader(heif.id);
  await notFoundForReader(webp.id);
  assert.equal((await raw(`/${heif.id}`, pm)).status, 200);
  assert.equal(
    (await expectStatus(call(`/photos/${heif.id}/meta`, pm), 200)).photo.id,
    heif.id,
  );
  pass(
    'OD18: after submission a reader lists, reads and fetches only the photos frozen in the revision, with their frozen link and version 0; a photo linked after submission or never frozen is 404 for the reader and still readable by the PM',
  );
  pass(
    'coverage asks for a photo only where a work item has quantity and no currently linked photo; linking clears it; the day reports its unlinked photos; the submitted revision freezes only the linked photos (source, position kind, accuracy, times, link) without coordinates; a relink, or linking a photo left out, after submission is allowed and leaves the revision unchanged',
  );

  // ---------- day lock: a submitted day takes photos only during a correction ----------
  await expectStatus(upload(pm, album(), jpeg('late')), 409, 'LOCKED');
  // Replaying an upload accepted before the lock still returns its stored response.
  assert.equal((await upload(pm, firstUpload, shot1, thumb1)).status, 200);
  const correcting = await expectStatus(
    call('/correction/start', pm, {
      projectId: projectA,
      businessDate: D1,
      expectedVersion: view.version,
      clientMutationId: key(),
      reason: 'TEST missing rail photo',
    }),
    200,
  );
  const late = await expectStatus(
    upload(pm, camera({ workItemKey: 'rail' }), jpeg('late-rail')),
    200,
  );
  // OD18: during the correction the reader still gets revision 1; the new photo is not found.
  const execDuring = await expectStatus(list(D1, exec), 200);
  assert.deepEqual(ids(execDuring.photos), ids(rev1.snapshot.photos));
  const execDayDuring = await expectStatus(day(D1, exec), 200);
  assert.equal(execDayDuring.state, 'submitted');
  assert.equal(execDayDuring.currentRevisionNumber, 1);
  assert.deepEqual(execDayDuring.photos, execFrozen.photos);
  await notFoundForReader(late.id);
  const second = await expectStatus(
    call('/submit', pm, {
      projectId: projectA,
      businessDate: D1,
      expectedVersion: correcting.version,
      clientMutationId: key(),
    }),
    200,
  );
  assert.equal(second.revisionNumber, 2);
  assert.deepEqual(photoMissing(second), []);
  const rev2 = await expectStatus(rev(2), 200);
  // The 4 of revision 1, the photo linked afterwards and the late one; webp is still unlinked.
  assert.equal(rev2.snapshot.photos.length, 6);
  assert.ok(!rev2.snapshot.photos.some((p) => p.id === webp.id));
  assert.deepEqual(rev2.snapshot.photos.find((p) => p.id === late.id).link, {
    type: 'item',
    id: 'rail',
  });
  assert.deepEqual(await expectStatus(rev(1), 200), rev1);
  await expectStatus(upload(pm, album(), jpeg('after-2')), 409, 'LOCKED');
  // OD18: after the resubmission the reader gets revision 2's photos, heif and the late one too.
  const execRev2 = await expectStatus(list(D1, exec), 200);
  assert.deepEqual(ids(execRev2.photos), ids(rev2.snapshot.photos));
  for (const id of [late.id, heif.id])
    assert.equal((await raw(`/${id}`, exec)).status, 200);
  await notFoundForReader(webp.id);
  // Another day stays open; its photo is not the reader's until that day is submitted.
  const d3Photo = await expectStatus(
    upload(pm, album({ businessDate: D3 }), jpeg('d3')),
    200,
  );
  await notFoundForReader(d3Photo.id);
  assert.deepEqual((await expectStatus(list(D3, exec), 200)).photos, []);
  assert.ok(
    ids((await expectStatus(list(D3), 200)).photos).includes(d3Photo.id),
  );
  pass(
    'a submitted day refuses uploads (409 LOCKED) but replays still answer; during a correction a photo is accepted and the next revision includes it (a reader sees revision 1 until then, OD18); revision 1 unchanged; other days unaffected',
  );

  // ---------- concurrency: the same new file uploaded twice at once ----------
  const putsBefore = puts.length;
  const rowsBefore = await photoRows();
  const twinShot = jpeg('parallel');
  const parallel = await Promise.all(
    [0, 1, 2].map(() => upload(pm, album({ businessDate: D2 }), twinShot)),
  );
  assert.deepEqual(
    parallel.map((r) => r.status),
    [200, 200, 200],
  );
  assert.equal(new Set(parallel.map((r) => r.body.id)).size, 1);
  assert.deepEqual(parallel.map((r) => r.body.deduplicated).sort(), [
    false,
    true,
    true,
  ]);
  assert.equal(await photoRows(), rowsBefore + 1);
  assert.equal(puts.length, putsBefore + 1);
  // Racing a submission: the photo either makes the revision or finds the day locked.
  const d2 = await expectStatus(day(D2), 200);
  const [raceUpload, raceSubmit] = await Promise.all([
    upload(
      pm,
      album({ businessDate: D2, workItemKey: 'support' }),
      jpeg('vs-submit'),
    ),
    call('/submit', pm, {
      projectId: projectA,
      businessDate: D2,
      expectedVersion: d2.version,
      clientMutationId: key(),
    }),
  ]);
  assert.equal(raceSubmit.status, 200, JSON.stringify(raceSubmit.body));
  const d2rev = await expectStatus(
    call(`/revision?projectId=${projectA}&businessDate=${D2}&n=1`, pm),
    200,
  );
  if (raceUpload.status === 200)
    assert.ok(d2rev.snapshot.photos.some((p) => p.id === raceUpload.body.id));
  else {
    assert.equal(raceUpload.status, 409);
    assert.equal(raceUpload.body.code, 'LOCKED');
  }
  pass(
    `three simultaneous uploads of one new file make one row and one blob write; an upload racing a submission is either in the revision or refused as LOCKED (this run: ${raceUpload.status})`,
  );

  // ---------- database-level protections ----------
  const rejectsWith = async (client, statement, params, check) => {
    await client.query('SAVEPOINT probe');
    let error;
    try {
      await client.query(statement, params);
    } catch (e) {
      error = e;
    }
    await client.query('ROLLBACK TO SAVEPOINT probe');
    assert.ok(error, `accepted: ${statement}`);
    check(error);
  };
  const code = (c, pattern) => (e) => {
    assert.equal(e.code, c, e.message);
    if (pattern) assert.match(e.message, pattern);
  };
  const constraint = (name) => (e) => {
    assert.equal(e.code, '23514', e.message);
    assert.equal(e.constraint, name);
  };
  const insertPhoto = `INSERT INTO "PhotoEvidence"(id,"orgId","updatedAt","updatedBy",sha256,"blobKey","mediaType","sizeBytes","projectId","businessDate",source,
      "captureLat","captureLon","captureAccuracyM","captureFixAt","uploadedByAccountId","uploadedByPersonId")
    VALUES($1,$2,now(),$3,$4,$12,'image/jpeg',10,$5,'2026-10-09',$6,$7,$8,$9,$10,$3,$11)`;
  const photoParams = (org, over = {}) => {
    const p = {
      source: 'camera',
      lat: '44.8',
      lon: '20.4',
      acc: '5',
      at: '2026-10-09T08:00:00Z',
      ...over,
    };
    const hash = randomBytes(32).toString('hex');
    return [
      randomUUID(),
      org,
      org === orgA ? accountPm : accountB,
      hash,
      org === orgA ? projectA : projectB,
      p.source,
      p.lat,
      p.lon,
      p.acc,
      p.at,
      org === orgA ? personPm : personB,
      `${org}/${hash}`,
    ];
  };
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
    for (const table of ['PhotoEvidence', 'EvidenceLink'])
      assert.equal(
        (await client.query(`SELECT count(*)::int AS n FROM "${table}"`))
          .rows[0].n,
        0,
        table,
      );
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM "PhotoEvidence"'))
        .rows[0].n,
      await photoRows(),
    );
    await rejectsWith(
      client,
      insertPhoto,
      photoParams(orgB),
      code('42501', /row-level security policy for table "PhotoEvidence"/),
    );
    await rejectsWith(
      client,
      insertPhoto,
      photoParams(orgA, { lat: null }),
      constraint('PhotoEvidence_camera_fix_check'),
    );
    await rejectsWith(
      client,
      insertPhoto,
      photoParams(orgA, { source: 'album' }),
      constraint('PhotoEvidence_album_no_fix_check'),
    );
    await rejectsWith(
      client,
      insertPhoto,
      photoParams(orgA, { lat: '95' }),
      constraint('PhotoEvidence_coordinates_check'),
    );
    await rejectsWith(
      client,
      `INSERT INTO "EvidenceLink"(id,"orgId","updatedAt","updatedBy","coverageDescription","photoId","businessDate","workItemKey","issueId")
      VALUES($1,$2,now(),$3,'',$4,$5,'rail',$6)`,
      [randomUUID(), orgA, accountPm, p1.id, D1, issue.id],
      constraint('EvidenceLink_report_target_check'),
    );
    await rejectsWith(
      client,
      `INSERT INTO "EvidenceLink"(id,"orgId","updatedAt","updatedBy","coverageDescription","photoId","businessDate","workItemKey")
      VALUES($1,$2,now(),$3,'',$4,$5,'rail')`,
      [randomUUID(), orgA, accountPm, p1.id, D1],
      code('23505'),
    );
    const superseded = (
      await client.query(
        'SELECT id FROM "EvidenceLink" WHERE "photoId"=$1 AND "supersededAt" IS NOT NULL ORDER BY seq LIMIT 1',
        [noGps.id],
      )
    ).rows[0].id;
    await rejectsWith(
      client,
      'UPDATE "EvidenceLink" SET "supersededAt"=now() WHERE id=$1',
      [superseded],
      code('P0001', /superseded, once/),
    );
    for (const statement of [
      'UPDATE "PhotoEvidence" SET "businessDate"=\'2026-01-01\'',
      'UPDATE "PhotoEvidence" SET "captureLat"=0',
      'DELETE FROM "PhotoEvidence"',
      'UPDATE "EvidenceLink" SET "workItemKey"=\'rail\'',
      'DELETE FROM "EvidenceLink"',
    ]) {
      await client.query('SAVEPOINT guard');
      await assert.rejects(
        client.query(statement),
        /permission denied/,
        statement,
      );
      await client.query('ROLLBACK TO SAVEPOINT guard');
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  // Even the owner cannot delete or rewrite a report link.
  await assert.rejects(
    owner.query('DELETE FROM "EvidenceLink" WHERE "photoId"=$1', [p1.id]),
    /append-only/,
  );
  await assert.rejects(
    owner.query(
      'UPDATE "EvidenceLink" SET "workItemKey"=\'rail\' WHERE "photoId"=$1 AND "supersededAt" IS NULL',
      [p1.id],
    ),
    /superseded, once/,
  );
  assert.equal(toSupport.link.id, 'support');
  const byAction = await owner.query(
    `SELECT action, count(*)::int AS n FROM "AuditLog" WHERE action LIKE 'PHOTO_%' GROUP BY action ORDER BY action`,
  );
  const photoLinks = await count(
    `SELECT count(*)::int AS n FROM "EvidenceLink" WHERE "businessDate" IS NOT NULL`,
  );
  const uploadsWithLink = await count(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE action='PHOTO_UPLOAD' AND after->'link' <> 'null'::jsonb`,
  );
  const counts = Object.fromEntries(byAction.rows.map((r) => [r.action, r.n]));
  assert.equal(counts.PHOTO_UPLOAD, await photoRows());
  // Every inserted link row is audited once: by the upload that carried it or by PHOTO_LINK.
  assert.equal(counts.PHOTO_LINK + uploadsWithLink, photoLinks);
  assert.equal(counts.PHOTO_UNLINK, 2);
  const shapes = await owner.query(
    `SELECT DISTINCT jsonb_typeof(after) AS t FROM "AuditLog" WHERE action LIKE 'PHOTO_%'`,
  );
  assert.deepEqual(
    shapes.rows.map((r) => r.t),
    ['object'],
  );
  // No response ever carried a storage URL, SAS token or emulator address.
  for (const text of responses)
    assert.ok(
      !/blob\.core|sig=|127\.0\.0\.1:11001|localhost:11001|evidence-test-/.test(
        text,
      ),
      text.slice(0, 200),
    );
  pass(
    'RLS hides photos and links from another org and refuses a cross-org insert (42501); CHECKs refuse a camera row without fix, an album row with an uploader fix, off-globe coordinates and a link to both an item and an issue; one current link per photo (23505); a superseded link cannot change again; the app role cannot update or delete photos nor rewrite or delete links; even the owner cannot; every upload and link change audited once; no response carries a blob URL or SAS',
  );

  console.log(
    `Photo HTTP/DB/blob integration: ${checks} checks passed; synthetic TEST images only. The web UI for photos is a later slice.`,
  );
} finally {
  if (app) await app.close();
  if (appPool) await appPool.end();
  if (owner) await owner.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  await admin.end();
  if (blobs) await blobs.deleteContainer();
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkMapping,
  parseEntraLabel,
  tokenTenant,
} from './entra-mapping.mjs';

// Synthetic TEST identifiers only.
const TENANT = '10000000-0000-4000-8000-00000000000a';
const OTHER = '10000000-0000-4000-8000-00000000000b';
const APP = '10000000-0000-4000-8000-000000000001';
const jwt = (claims) =>
  [
    'e30',
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
  ].join('.');
const label = (text) => [{ label: text }];
const good = {
  labels: label(`aadauth,oid=${APP},type=service`),
  listed: [],
  serverTenant: TENANT,
  appObjectId: APP,
  tenantId: TENANT,
};

test('the server tenant comes from the accepted token and must be a GUID', () => {
  assert.equal(tokenTenant(jwt({ tid: TENANT.toUpperCase() })), TENANT);
  for (const bad of ['', 'a.b', jwt({}), jwt({ tid: 'common' }), 'x.%%%.y'])
    assert.equal(tokenTenant(bad), null);
});

test('labels are parsed strictly', () => {
  assert.deepEqual(parseEntraLabel(`aadauth, type=Service ,oid=${APP}`), {
    oid: APP,
    type: 'service',
    admin: false,
    mfa: false,
  });
  assert.equal(
    parseEntraLabel(`aadauth,oid=${APP},type=service,admin`).admin,
    true,
  );
  for (const bad of [
    `oid=${APP},aadauth,type=service`,
    `aadauth,oid=${APP}`,
    `aadauth,oid=${APP},oid=${OTHER},type=service`,
    `aadauth,oid=${APP},type=service,type=user`,
    `aadauth,oid=${APP},type=service,extra`,
    `aadauth,oid=${APP},type=service,admin=1`,
    `aadauth,oid = ${APP},type=service`,
    `aadauth,oid=,type=service`,
  ])
    assert.equal(parseEntraLabel(bad), null, bad);
});

test('an empty listing does not skip the tenant check', () => {
  assert.equal(checkMapping(good), null);
  assert.match(
    checkMapping({ ...good, tenantId: OTHER }),
    /not the tenant of this database server/,
  );
  assert.match(
    checkMapping({ ...good, serverTenant: null }),
    /could not be established/,
  );
});

test('the label decides object, type and flags; a listed row must agree', () => {
  const cases = [
    [{ labels: [] }, /0 Entra labels/],
    [{ labels: [...good.labels, ...good.labels] }, /2 Entra labels/],
    [
      { labels: label(`aadauth,oid=${OTHER},type=service`) },
      /another Entra object/,
    ],
    [
      { labels: label(`aadauth,oid=${APP},type=user`) },
      /not a service principal/,
    ],
    [{ labels: label(`aadauth,oid=${APP},type=service,admin`) }, /Entra admin/],
    [{ labels: label(`aadauth,oid=${APP},type=service,mfa`) }, /MFA/],
    [{ labels: label('something else') }, /not a recognised/],
  ];
  for (const [patch, message] of cases)
    assert.match(checkMapping({ ...good, ...patch }), message);
  const row = {
    rolename: 'mjeepc-dev-app',
    objectid: APP,
    principaltype: 'service',
    tenantid: TENANT,
    isadmin: 0,
    ismfa: 0,
  };
  assert.equal(checkMapping({ ...good, listed: [row] }), null);
  assert.match(checkMapping({ ...good, listed: [row, row] }), /more than once/);
  assert.match(
    checkMapping({ ...good, listed: [{ ...row, tenantid: OTHER }] }),
    /another tenant/,
  );
  assert.match(
    checkMapping({ ...good, listed: [{ ...row, objectid: OTHER }] }),
    /another Entra object/,
  );
  assert.match(
    checkMapping({ ...good, listed: [{ ...row, isadmin: 1 }] }),
    /admin/,
  );
});

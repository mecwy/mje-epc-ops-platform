/**
 * ADR-0003 D2.2 mechanical checks on the real application: every registered HTTP route is in
 * authz/surface.ts and every surface route is registered (all stores present), every Worker /
 * CLI entry file is registered, and the report read routes reach the report module exit.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import {
  AlphaStore,
  CheckInStore,
  FieldStore,
  ForemanStore,
  IssueStore,
  PhotoStore,
  ReportStore,
  ProjectStatusCommands,
  ProjectStatusReader,
  ProjectHomeReader,
  WeatherStore,
  reportReader,
  type ReportReadContext,
} from '@mje/domain';
import { PROCESS_ENTRIES, SURFACE } from '@mje/domain/authz';
import { createApp, type AlphaRuntime } from './app.js';
import type { TokenVerifier } from './auth/token-verifier.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const IDENTITY = { tenantId: 'TEST-tenant', objectId: 'TEST-object' };
const CTX = { TEST: 'context' } as unknown as ReportReadContext;
const PROJECT = '11111111-1111-4111-8111-111111111111';

/** Stores are never called by enumeration; the report store hands the exit a TEST context. */
function runtime(): AlphaRuntime {
  const reportStore = Object.create(ReportStore.prototype) as ReportStore;
  reportStore.read = (async (
    _identity: unknown,
    use: (ctx: ReportReadContext) => Promise<unknown>,
  ) => use(CTX)) as ReportStore['read'];
  return {
    store: Object.create(AlphaStore.prototype) as AlphaStore,
    reportStore,
    weatherStore: Object.create(WeatherStore.prototype) as WeatherStore,
    projectStatusCommands: Object.create(
      ProjectStatusCommands.prototype,
    ) as ProjectStatusCommands,
    projectStatusReader: Object.create(
      ProjectStatusReader.prototype,
    ) as ProjectStatusReader,
    projectHomeReader: Object.create(
      ProjectHomeReader.prototype,
    ) as ProjectHomeReader,
    issueStore: Object.create(IssueStore.prototype) as IssueStore,
    photoStore: Object.create(PhotoStore.prototype) as PhotoStore,
    fieldStore: Object.create(FieldStore.prototype) as FieldStore,
    checkInStore: Object.create(CheckInStore.prototype) as CheckInStore,
    foremanStore: Object.create(ForemanStore.prototype) as ForemanStore,
    verifier: { verify: async () => IDENTITY } as unknown as TokenVerifier,
    auth: {
      tenantId: 'TEST-tenant',
      audience: 'TEST-audience',
      clientId: 'TEST-client',
      scope: 'access_as_user',
    },
  };
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}
function registered(app: INestApplication): string[] {
  const server = app.getHttpAdapter().getInstance() as unknown as {
    router: { stack: Layer[] };
  };
  return server.router.stack.flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods)
          .filter((m) => layer.route!.methods[m] && m !== '_all')
          .map((m) => `${m.toUpperCase()} ${layer.route!.path}`)
      : [],
  );
}

let app: INestApplication;
beforeAll(async () => {
  app = await createApp(runtime());
  await app.init();
  await app.listen(0, '127.0.0.1');
});
afterAll(async () => {
  await app?.close();
});

describe('route enumeration (ADR-0003 D2.2)', () => {
  it('every registered route is in surface.ts and every HTTP surface entry is registered', () => {
    const routes = registered(app).sort();
    const http = SURFACE.filter((e) => /^[A-Z]+ \//.test(e.entry))
      .map((e) => e.entry)
      .sort();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((r) => !http.includes(r))).toEqual([]);
    expect(http.filter((r) => !routes.includes(r))).toEqual([]);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

/**
 * Process entry convention (ADR-0003 D2.2; PR #51 review 6):
 * - every non-test source under apps/worker/src, at any depth, is a worker entry;
 * - an apps/api/src source (any depth) is a CLI entry exactly when it carries the one accepted
 *   main guard `import.meta.url === pathToFileURL(process.argv[1]).href`;
 * - apps/api/src/main.ts is the HTTP host, enumerated by its routes;
 * - any other main-module test (`import.meta.main`, `require.main`, `process.argv[1]` in another
 *   form) is refused, so an entry cannot hide behind a different guard;
 * - every `dist/<file>.js` a Dockerfile, app package script or Bicep job launches is the HTTP
 *   host or a registered entry.
 * Discovered and registered entries must be the same set.
 */
export const CANONICAL_GUARD =
  /import\.meta\.url\s*===\s*pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href/;
const OTHER_GUARD =
  /import\.meta\.main|require\.main|process\.argv\[1\]|import\.meta\.filename\s*===|import\.meta\.path\s*===/;
const HTTP_HOST = 'apps/api/src/main.ts';
// This adapter is injected by a caller; it has no process entry or default transport.
// Keep the exemption exact and prove it cannot execute code when loaded.
const WORKER_SUPPORT_MODULES = [
  'apps/worker/src/weather-provider.ts',
  'apps/worker/src/weather-worker.ts',
];
function inertModule(text: string) {
  const source = ts.createSourceFile(
    'support.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const literal = (node: ts.Node): boolean =>
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    (ts.isObjectLiteralExpression(node) &&
      node.properties.every(
        (p) =>
          ts.isPropertyAssignment(p) &&
          !ts.isComputedPropertyName(p.name) &&
          literal(p.initializer),
      )) ||
    (ts.isAsExpression(node) && literal(node.expression));
  return source.statements.every(
    (s) =>
      (ts.isImportDeclaration(s) &&
        s.importClause !== undefined &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        (s.importClause.isTypeOnly ||
          ['@mje/contracts', './weather-provider.js'].includes(
            s.moduleSpecifier.text,
          ))) ||
      ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) ||
      ts.isFunctionDeclaration(s) ||
      (ts.isClassDeclaration(s) &&
        !(ts.canHaveDecorators(s) && ts.getDecorators(s)?.length) &&
        (!s.heritageClauses ||
          s.heritageClauses.every(
            (h) =>
              h.token === ts.SyntaxKind.ExtendsKeyword &&
              h.types.every(
                (t) =>
                  ts.isIdentifier(t.expression) &&
                  t.expression.text === 'Error',
              ),
          )) &&
        s.members.every(
          (m) =>
            !ts.isClassStaticBlockDeclaration(m) &&
            !(m.name && ts.isComputedPropertyName(m.name)) &&
            !(ts.canHaveDecorators(m) && ts.getDecorators(m)?.length) &&
            !(
              ts.canHaveModifiers(m) &&
              ts
                .getModifiers(m)
                ?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)
            ),
        )) ||
      (ts.isVariableStatement(s) &&
        s.declarationList.declarations.every(
          (d) => d.initializer !== undefined && literal(d.initializer),
        )),
  );
}
function sourcesUnder(dir: string): string[] {
  return readdirSync(repo + dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourcesUnder(`${dir}${d.name}/`)
      : d.name.endsWith('.ts') && !d.name.endsWith('.test.ts')
        ? [`${dir}${d.name}`]
        : [],
  );
}
export function discoverEntries(
  read = (f: string) => readFileSync(repo + f, 'utf8'),
) {
  const entries: string[] = [];
  const refused: string[] = [];
  for (const file of sourcesUnder('apps/worker/src/')) {
    if (WORKER_SUPPORT_MODULES.includes(file)) {
      if (!inertModule(read(file))) refused.push(file);
    } else entries.push(file);
  }
  for (const file of sourcesUnder('apps/api/src/')) {
    const text = read(file);
    const canonical = CANONICAL_GUARD.test(text);
    if (canonical) entries.push(file);
    if (OTHER_GUARD.test(text.replace(CANONICAL_GUARD, '')) && !canonical)
      refused.push(file);
  }
  return { entries: entries.sort(), refused };
}
function launched(): string[] {
  const configs = [
    ...readdirSync(repo).filter((f) => f.startsWith('Dockerfile')),
    'apps/api/package.json',
    'apps/worker/package.json',
    ...readdirSync(repo + 'infra/bicep')
      .filter((f) => f.endsWith('.bicep'))
      .map((f) => `infra/bicep/${f}`),
  ];
  return configs.flatMap((config) => {
    const app = config.startsWith('apps/worker') ? 'worker' : 'api';
    return [
      ...readFileSync(repo + config, 'utf8').matchAll(/dist\/([\w/-]+)\.js/g),
    ].map((m) => `apps/${app}/src/${m[1]}.ts`);
  });
}

describe('Worker / CLI entry enumeration (ADR-0003 D2.2)', () => {
  it('refuses executable code in the exact worker support module', () => {
    for (const code of [
      'fetch("https://example.invalid")',
      'const job = start()',
      'class Job { static { start() } }',
      'import "./start.js"',
      'class Job extends start() {}',
      'class Job { [start()]() {} }',
      'const values = { [start()]: "safe" }',
      '@start() class Job {}',
    ]) {
      expect(
        discoverEntries((f) =>
          WORKER_SUPPORT_MODULES.includes(f)
            ? code
            : readFileSync(repo + f, 'utf8'),
        ).refused,
      ).toEqual(WORKER_SUPPORT_MODULES);
    }
  });
  it('discovered entries and registered entries are the same set', () => {
    const { entries, refused } = discoverEntries();
    expect(refused).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toEqual([...PROCESS_ENTRIES].sort());
  });
  it('every launched dist file is the HTTP host or a registered entry', () => {
    const found = launched();
    expect(found).toContain('apps/api/src/cleanup-selfies.ts');
    expect(
      found.filter((f) => f !== HTTP_HOST && !PROCESS_ENTRIES.includes(f)),
    ).toEqual([]);
  });
});

describe('report read routes go through the report exit (ADR-0003 D2.2)', () => {
  const reads = {
    'GET /api/report/projects': ['projects', ''],
    'GET /api/report/days': [
      'days',
      `?projectId=${PROJECT}&from=2026-09-01&to=2026-09-07`,
    ],
    'GET /api/report/day': [
      'day',
      `?projectId=${PROJECT}&businessDate=2026-09-01`,
    ],
    'GET /api/report/people-window': [
      'peopleWindow',
      `?projectId=${PROJECT}&businessDate=2026-09-01`,
    ],
    'GET /api/report/revision': [
      'revision',
      `?projectId=${PROJECT}&businessDate=2026-09-01&n=1`,
    ],
    'GET /api/report/plan': [
      'plan',
      `?projectId=${PROJECT}&targetBusinessDate=2026-09-02`,
    ],
    'GET /api/report/items': ['items', `?projectId=${PROJECT}`],
    'GET /api/weather/locations': ['weatherLocations', `?projectId=${PROJECT}`],
    'GET /api/weather/requests': [
      'weatherRequest',
      `?projectId=${PROJECT}&requestId=${PROJECT}`,
    ],
    'GET /api/weather/snapshots': [
      'weatherSnapshot',
      `?projectId=${PROJECT}&snapshotId=${PROJECT}`,
    ],
    'GET /api/weather/report-location/coordinates': [
      'reportLocationCoordinates',
      `?projectId=${PROJECT}&recordId=${PROJECT}`,
    ],
  } as const;
  it('covers every report read entry of surface.ts', () => {
    const surfaced = SURFACE.filter(
      (e) => e.kind === 'read' && e.capability.includes('report.view'),
    ).map((e) => e.entry);
    expect(Object.keys(reads).sort()).toEqual(surfaced.sort());
  });
  for (const [entry, [method, query]] of Object.entries(reads))
    it(`${entry} calls reportReader.forContext(ctx).${method}`, async () => {
      const calls: string[] = [];
      const view = Object.fromEntries(
        Object.keys(reportReader.forContext(CTX)).map((name) => [
          name,
          async () => {
            calls.push(name);
            return { TEST: name };
          },
        ]),
      );
      const spy = vi
        .spyOn(reportReader, 'forContext')
        .mockImplementation((ctx) => {
          expect(ctx).toBe(CTX);
          return view as unknown as ReturnType<typeof reportReader.forContext>;
        });
      try {
        const url = (await app.getUrl()) + entry.slice(4) + query;
        const response = await fetch(url, {
          headers: { Authorization: 'Bearer TEST' },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ TEST: method });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([method]);
      } finally {
        spy.mockRestore();
      }
    });
});

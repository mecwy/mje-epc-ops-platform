/**
 * ADR-0003 D2.2 mechanical checks on the real application: every registered HTTP route is in
 * authz/surface.ts and every surface route is registered (all stores present), every Worker /
 * CLI entry file is registered, and the report read routes reach the report module exit.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

describe('Worker / CLI entry enumeration (ADR-0003 D2.2)', () => {
  /** Process entry files: the worker's sources and every file with a main-module guard. */
  function entryFiles(): string[] {
    const files: string[] = [];
    for (const app of ['api', 'worker']) {
      const dir = `apps/${app}/src`;
      for (const name of readdirSync(repo + dir)) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        const text = readFileSync(`${repo}${dir}/${name}`, 'utf8');
        const guarded =
          /import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]/.test(
            text,
          );
        if (app === 'worker' || guarded || name.startsWith('cleanup-'))
          files.push(`${dir}/${name}`);
      }
    }
    return files.sort();
  }
  it('every entry file is registered and every registered entry exists', () => {
    const files = entryFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !PROCESS_ENTRIES.includes(f))).toEqual([]);
    expect(PROCESS_ENTRIES.filter((f) => !existsSync(repo + f))).toEqual([]);
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
    'GET /api/report/revision': [
      'revision',
      `?projectId=${PROJECT}&businessDate=2026-09-01&n=1`,
    ],
    'GET /api/report/plan': [
      'plan',
      `?projectId=${PROJECT}&targetBusinessDate=2026-09-02`,
    ],
    'GET /api/report/items': ['items', `?projectId=${PROJECT}`],
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

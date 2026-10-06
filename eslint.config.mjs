import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// ADR-0003 D2.1 / D2.4 module boundary, checked on resolved import paths (so `././x.js` or
// `../src/x.js` cannot slip past a string match). Mirrors authz/legacy-adapters.ts MODULES;
// authz/boundary.test.ts keeps the two in step.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = 'packages/domain/src/';
export const BOUNDARY = {
  /** Modules whose internals other modules reach only through their exits. */
  modules: {
    opportunity: [
      'commands.ts',
      'data.ts',
      'grants.ts',
      'projection.ts',
      'reader.ts',
      'rules.ts',
    ].map((f) => D + 'opportunity/' + f),
    'contract-register': [
      'grants.ts',
      'reader.ts',
      'rules.ts',
      'validation.ts',
      'data.ts',
      'commands.ts',
    ].map((f) => D + 'contract-register/' + f),
    'project-status': [
      'commands.ts',
      'reader.ts',
      'context.ts',
      'rules.ts',
    ].map((f) => D + 'project-status/' + f),
    'project-home': ['reader.ts', 'aggregate.ts', 'rules.ts'].map(
      (f) => D + 'project-home/' + f,
    ),
    report: [
      'report-store.ts',
      'report-reader.ts',
      'report-read-context.ts',
      'report-commands.ts',
      'report-lookups.ts',
      'report-rules.ts',
      'personnel-metrics.ts',
      'weather-store.ts',
      'weather-jobs.ts',
      'reader-view.ts',
    ].map((f) => D + f),
    issue: ['issue-store.ts', 'issue-reader.ts', 'issue-lookups.ts'].map(
      (f) => D + f,
    ),
    photo: ['photo-store.ts', 'photo-file.ts', 'photo-strip.ts'].map(
      (f) => D + f,
    ),
  },
  /** Exit files and the names they export to other modules (null: every name). */
  exits: {
    [`${D}opportunity/commands.ts`]: { only: ['OpportunityCommands'] },
    [`${D}opportunity/reader.ts`]: { only: ['OpportunityReader'] },
    [`${D}opportunity/rules.ts`]: { only: ['OpportunityError'] },
    [`${D}contract-register/commands.ts`]: {
      only: ['ContractRegisterCommands'],
    },
    [`${D}contract-register/reader.ts`]: { only: ['ContractRegisterReader'] },
    [`${D}contract-register/rules.ts`]: { only: ['ContractRegisterError'] },
    [`${D}project-status/commands.ts`]: { only: ['ProjectStatusCommands'] },
    [`${D}project-status/reader.ts`]: {
      only: [
        'ProjectStatusReader',
        'projectStatusReader',
        'ProjectStatusHomeDto',
      ],
    },
    [`${D}project-status/context.ts`]: {
      only: ['withProjectStatusReadContext', 'ProjectStatusReadContext'],
    },
    [`${D}project-status/rules.ts`]: {
      only: ['ProjectStatusError', 'requiredStatusFields'],
    },
    [`${D}report-reader.ts`]: {
      except: [
        'readerContent',
        'readerDayState',
        'readerNextPlan',
        'readerPlan',
        'readerSnapshot',
        'observeReportProjections',
        'REPORT_PROJECTORS',
      ],
    },
    [`${D}weather-store.ts`]: { only: ['WeatherStore', 'WeatherStoreError'] },
    [`${D}weather-jobs.ts`]: {
      only: [
        'claimWeatherJob',
        'finishWeatherJob',
        'failWeatherJob',
        'WeatherJobLease',
        'WeatherJobFailure',
        'WeatherSnapshotMetadata',
      ],
    },
    [`${D}report-read-context.ts`]: {
      only: ['withReportReadContext', 'ReportReadContext'],
    },
    [`${D}issue-reader.ts`]: {
      only: [
        'issueReader',
        'withIssueReadContext',
        'IssueReadContext',
        'IssueHomeDto',
      ],
    },
    // A7-0d: the report day writes other modules run in their own transaction.
    [`${D}report-commands.ts`]: {},
    // Internal facts on an account or device caller's existing transaction.
    [`${D}report-lookups.ts`]: {
      only: [
        'activeWorkItemExists',
        'activeWorkItemKeys',
        'activeWorkItemCatalog',
        'reportFrozenPhotos',
        'reportPhotoWasFrozen',
        'latestReportFrozenPhoto',
        'reportUploadDayState',
        'reportSubmittedBoundary',
        'alphaRecordList',
        'alphaRecordFact',
        'alphaRecordRevisions',
        'alphaRecordSavedAt',
      ],
    },
    [`${D}issue-lookups.ts`]: { only: ['siteIssueExists'] },
    [`${D}report-rules.ts`]: {},
  },
  /** SQL owners and the home transaction composition root may import `pg`. */
  pg: [
    ...['commands.ts', 'data.ts', 'grants.ts', 'reader.ts'].map(
      (f) => D + 'opportunity/' + f,
    ),
    D + 'contract-register/commands.ts',
    D + 'contract-register/data.ts',
    D + 'contract-register/grants.ts',
    D + 'contract-register/reader.ts',
    ...['commands.ts', 'reader.ts', 'context.ts'].map(
      (f) => D + 'project-status/' + f,
    ),
    D + 'project-home/reader.ts',
    ...[
      'store-kit.ts',
      'manager-review-store.ts',
      'manager-review-reader.ts',
      'business-evidence-store.ts',
      'business-evidence-reader.ts',
      'weather-store.ts',
      'weather-jobs.ts',
      'alpha-store.ts',
      'report-store.ts',
      'report-read-context.ts',
      'report-commands.ts',
      'report-lookups.ts',
      'issue-store.ts',
      'issue-reader.ts',
      'issue-lookups.ts',
      'photo-store.ts',
      'field-store.ts',
      'field-kit.ts',
      'field-roster.ts',
      'checkin-store.ts',
      'foreman-store.ts',
    ].map((f) => D + f),
    // Composition roots that create the pool.
    'apps/api/src/main.ts',
    'apps/api/src/cleanup-selfies.ts',
    'apps/api/src/runtime-env.ts',
  ],
  /** Files that may import store-kit: SQL owners, cross-module transaction composition, and barrel. */
  storeKit: [
    ...['commands.ts', 'grants.ts', 'reader.ts'].map(
      (f) => D + 'opportunity/' + f,
    ),
    D + 'contract-register/commands.ts',
    D + 'contract-register/grants.ts',
    D + 'contract-register/reader.ts',
    ...['commands.ts', 'reader.ts', 'context.ts'].map(
      (f) => D + 'project-status/' + f,
    ),
    ...[
      'weather-store.ts',
      'manager-review-store.ts',
      'manager-review-reader.ts',
      'business-evidence-store.ts',
      'business-evidence-reader.ts',
      // A7-0b: the alpha store runs on the shared account transaction (ADR-0003 D5).
      'alpha-store.ts',
      'report-store.ts',
      'report-reader.ts',
      'report-lookups.ts',
      'report-read-context.ts',
      'issue-store.ts',
      'issue-reader.ts',
      'photo-store.ts',
      'field-store.ts',
      'field-kit.ts',
      'field-roster.ts',
      'checkin-store.ts',
      'foreman-store.ts',
      'project-home/reader.ts',
      'index.ts',
    ].map((f) => D + f),
  ],
  /** Cross-module imports of internals that exist today (importer, target); removed in A7-0e. */
  legacy: [
    ['checkin-store.ts', 'photo-file.ts'],
    ['checkin-store.ts', 'photo-store.ts'],
    ['checkin-store.ts', 'photo-strip.ts'],
    ['photo-store.ts', 'reader-view.ts'],
    ['report-reader.ts', 'issue-store.ts'],
    ['report-reader.ts', 'photo-store.ts'],
    ['report-store.ts', 'issue-store.ts'],
    ['report-store.ts', 'photo-store.ts'],
  ].map(([a, b]) => [D + a, D + b]),
  /** Package subpaths apps may import besides the barrel. */
  subpaths: ['@mje/domain/authz', '@mje/domain/rules'],
};

const moduleOf = (file) =>
  Object.entries(BOUNDARY.modules).find(([, files]) =>
    files.includes(file),
  )?.[0];
/** Why importing `spec` (with `names`) from repository file `file` breaks the boundary, if it does. */
export function boundaryViolation(file, spec, names, typeOnly) {
  if (spec === 'pg' || spec.startsWith('pg/'))
    return BOUNDARY.pg.includes(file)
      ? null
      : 'pg is imported only by files that own SQL (ADR-0003 D2.1)';
  if (spec.startsWith('@mje/domain/'))
    return BOUNDARY.subpaths.includes(spec)
      ? null
      : "import the domain through '@mje/domain' (ADR-0003 D2)";
  if (!spec.startsWith('.')) return null;
  const target = path.posix
    .normalize(path.posix.join(path.posix.dirname(file), spec))
    .replace(/\.js$/, '.ts');
  if (
    target.startsWith('packages/domain/') &&
    !file.startsWith('packages/domain/')
  )
    return "import the domain through '@mje/domain' (ADR-0003 D2)";
  if (target === `${D}store-kit.ts` && !BOUNDARY.storeKit.includes(file))
    return 'store-kit is imported only by files that own SQL (ADR-0003 D2.1)';
  const to = moduleOf(target);
  if (!to || to === moduleOf(file)) return null;
  if (file === `${D}index.ts`) return null;
  if (file.startsWith(`${D}authz/`) && typeOnly) return null;
  const exit = BOUNDARY.exits[target];
  if (exit) {
    // A namespace import, import() or `export * from` reaches every export ('*'): refused for
    // an exit that keeps some exports internal.
    if (names.includes('*') && (exit.only || exit.except))
      return `namespace, dynamic or star access to the ${to} module exit exposes its internal exports (ADR-0003 D2)`;
    const bad = names.filter(
      (n) => (exit.only && !exit.only.includes(n)) || exit.except?.includes(n),
    );
    if (!bad.length) return null;
    return `${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} internal to the ${to} module exit (ADR-0003 D2)`;
  }
  if (BOUNDARY.legacy.some(([a, b]) => a === file && b === target)) return null;
  return `${to} module internals are reached only through its exit (ADR-0003 D2)`;
}

const boundary = {
  meta: { type: 'problem', schema: [], messages: { boundary: '{{why}}' } },
  create(context) {
    const file = path
      .relative(ROOT, context.filename)
      .split(path.sep)
      .join('/');
    if (file.endsWith('.test.ts')) return {};
    const check = (node, spec, names, typeOnly) => {
      if (typeof spec !== 'string') return;
      const why = boundaryViolation(file, spec, names, typeOnly);
      if (why) context.report({ node, messageId: 'boundary', data: { why } });
    };
    const name = (n) => n?.name ?? n?.value;
    return {
      ImportDeclaration: (n) =>
        check(
          n,
          n.source.value,
          n.specifiers.map((s) =>
            s.type === 'ImportSpecifier'
              ? name(s.imported)
              : s.type === 'ImportDefaultSpecifier'
                ? 'default'
                : '*',
          ),
          n.importKind === 'type' ||
            (n.specifiers.length > 0 &&
              n.specifiers.every((s) => s.importKind === 'type')),
        ),
      ExportNamedDeclaration: (n) =>
        n.source &&
        check(
          n,
          n.source.value,
          n.specifiers.map((s) => name(s.local)),
          n.exportKind === 'type',
        ),
      ExportAllDeclaration: (n) => check(n, n.source.value, ['*'], false),
      ImportExpression: (n) =>
        n.source.type === 'Literal'
          ? check(n, n.source.value, ['*'], false)
          : context.report({
              node: n,
              messageId: 'boundary',
              data: {
                why: 'import() needs a literal path so the module boundary can be checked (ADR-0003 D2)',
              },
            }),
    };
  },
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/generated/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ['packages/**/*.ts', 'apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    plugins: { mje: { rules: { boundary } } },
    rules: { 'mje/boundary': 'error' },
  },
);

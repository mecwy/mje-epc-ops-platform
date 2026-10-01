import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// ADR-0003 D2: report data leaves the report module only through its exit (report-reader.ts:
// `reportReader`, its types; `reportReadContext` to hand over a transaction). Row helpers
// (report-store.ts), the report projections and opening a read context stay inside the module.
const REPORT_MODULE = [
  'packages/domain/src/report-store.ts',
  'packages/domain/src/report-reader.ts',
  'packages/domain/src/report-read-context.ts',
  'packages/domain/src/report-rules.ts',
  'packages/domain/src/reader-view.ts',
  'packages/domain/src/reader-view.test.ts',
  'packages/domain/src/index.ts',
];
const exitOnly =
  'report module internals: read report data through reportReader (report-reader.ts), ADR-0003 D2';
const reportInternals = (dir) => [
  { name: `${dir}/report-store.js`, message: exitOnly },
  {
    name: `${dir}/report-reader.js`,
    importNames: [
      'readerContent',
      'readerDayState',
      'readerPlan',
      'readerSnapshot',
      'observeReportProjections',
    ],
    message: exitOnly,
  },
  {
    name: `${dir}/report-read-context.js`,
    importNames: ['openReportReadContext'],
    message: exitOnly,
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/generated/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ['packages/domain/src/**/*.ts'],
    ignores: REPORT_MODULE,
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...reportInternals('.'), ...reportInternals('..')] },
      ],
    },
  },
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@mje/domain/dist/*', '**/packages/domain/**'],
              message: `${exitOnly}; import from '@mje/domain'`,
            },
          ],
        },
      ],
    },
  },
);

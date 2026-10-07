import type { Pool } from 'pg';
import {
  ContractRegisterReader,
  OpportunityCommands,
  OpportunityReader,
  ContractRegisterCommands,
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
} from '@mje/domain';
import { createApp, type AlphaRuntime } from './app.js';
import { TokenVerifier } from './auth/token-verifier.js';
import {
  assertApplicationLogin,
  applicationResourceLifecycle,
  databasePoolFromEnv,
  photoBlobsFromEnv,
  required,
  weatherConsumerConfig,
  weatherRuntimeFromEnv,
} from './runtime-env.js';

let runtime: AlphaRuntime | undefined;
let pool: Pool | undefined;
// Validate an enabled Dev consumer before opening application resources.
weatherConsumerConfig(process.env);
if (process.env['ALPHA_ENABLED'] === 'true') {
  const auth = {
    tenantId: required('ENTRA_TENANT_ID'),
    audience: required('ENTRA_API_CLIENT_ID'),
    clientId: required('ENTRA_SPA_CLIENT_ID'),
    scope: 'access_as_user',
  };
  const verifier = new TokenVerifier(auth);
  pool = databasePoolFromEnv();
  await assertApplicationLogin(pool);
  runtime = {
    auth,
    verifier,
    store: new AlphaStore(pool),
    contractRegisterReader: new ContractRegisterReader(pool),
    contractRegisterCommands: new ContractRegisterCommands(pool),
    opportunityCommands: new OpportunityCommands(pool),
    opportunityReader: new OpportunityReader(pool),
    reportStore: new ReportStore(pool, {
      weatherReferenceEnabled:
        process.env['WEATHER_REFERENCE_ENABLED'] === 'true',
      // Omission retains the legacy weather opt-in; any explicit non-true value is off.
      ...(process.env['REPORT_LOCATION_ENABLED'] !== undefined
        ? {
            reportLocationEnabled:
              process.env['REPORT_LOCATION_ENABLED'] === 'true',
          }
        : {}),
    }),
    projectStatusCommands: new ProjectStatusCommands(pool),
    projectStatusReader: new ProjectStatusReader(pool),
    projectHomeReader: new ProjectHomeReader(pool),
    issueStore: new IssueStore(pool),
    fieldStore: new FieldStore(pool),
    foremanStore: new ForemanStore(pool),
  };
  // Explicit opt-in after the weather migrations; transport and device capture stay separate.
  if (process.env['WEATHER_REFERENCE_ENABLED'] === 'true')
    runtime.weatherStore = new WeatherStore(pool);
  const blobs = await photoBlobsFromEnv();
  if (blobs) runtime.photoStore = new PhotoStore(pool, blobs);
  // Without a blob store check-ins still work; selfie upload answers FEATURE_OFF.
  runtime.checkInStore = new CheckInStore(pool, blobs ?? null);
}
const weather = pool ? weatherRuntimeFromEnv(pool) : undefined;
const resources = applicationResourceLifecycle({
  ...(weather ? { weather } : {}),
  closePool: async () => {
    await pool?.end();
  },
});
const app = await createApp(runtime, { resourceLifecycle: resources });
await app.listen(
  Number(process.env['PORT'] ?? 3300),
  process.env['HOST'] ?? '127.0.0.1',
);
weather?.start();

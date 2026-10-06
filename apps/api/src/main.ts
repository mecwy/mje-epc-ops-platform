import type { Pool } from 'pg';
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
} from '@mje/domain';
import { createApp, type AlphaRuntime } from './app.js';
import { TokenVerifier } from './auth/token-verifier.js';
import {
  assertApplicationLogin,
  databasePoolFromEnv,
  photoBlobsFromEnv,
  required,
} from './runtime-env.js';

let runtime: AlphaRuntime | undefined;
let pool: Pool | undefined;
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
    reportStore: new ReportStore(pool),
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
const app = await createApp(runtime);
await app.listen(
  Number(process.env['PORT'] ?? 3300),
  process.env['HOST'] ?? '127.0.0.1',
);
if (pool) {
  const database = pool;
  process.once('SIGTERM', () => {
    void database.end();
  });
  process.once('SIGINT', () => {
    void database.end();
  });
}

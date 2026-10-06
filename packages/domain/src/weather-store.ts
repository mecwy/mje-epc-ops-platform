/** C03 persistence joins the existing report transaction; it never writes a report/day. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  InvalidReportInput,
  buildWeatherQuery,
  parseConfigureWeatherLocationCommand,
  parseReportLocationOperation,
  parseSafeReportLocationRef,
  parseWeatherFactsExtension,
  parseWeatherRequestCommand,
  type ConfigureWeatherLocationCommand,
  type ReportLocationOperation,
  type SafeFrozenWeatherReference,
  type SafeReportLocationRef,
  type WeatherFactsExtension,
  type WeatherLocationDto,
  type WeatherRequestCommand,
  type WeatherRequestDto,
  type WeatherReferenceDraftDto,
} from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import {
  audit,
  idempotent,
  inTransaction,
  projectWriter,
  ReportError,
  type Actor,
} from './store-kit.js';
export interface WeatherDayScope {
  projectId: string;
  dailyCloseId: string;
  businessDate: string;
  siteTimezone: string;
}
export class WeatherStoreError extends Error {
  constructor(readonly code: 'WEATHER_STORE_FAILED') {
    super(code);
    this.name = 'WeatherStoreError';
  }
}
export async function weatherSafe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (
      e instanceof ReportError ||
      e instanceof InvalidReportInput ||
      e instanceof WeatherStoreError
    )
      throw e;
    throw new WeatherStoreError('WEATHER_STORE_FAILED');
  }
}
const iso = (v: Date | string) => new Date(v).toISOString();
async function writableDay(
  client: PoolClient,
  actor: Actor,
  scope: WeatherDayScope,
) {
  await projectWriter(client, actor, scope.projectId);
  const result = await client.query<{
    state: string;
    correctionReason: string | null;
  }>(
    `SELECT state,"correctionReason" FROM "DailyClose" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3 AND "businessDate"=$4::date AND "siteTimezone"=$5 AND "scopeKey"='report'`,
    [
      actor.orgId,
      scope.projectId,
      scope.dailyCloseId,
      scope.businessDate,
      scope.siteTimezone,
    ],
  );
  if (!result.rows[0]) throw new ReportError('NOT_FOUND');
  if (
    result.rows[0].state === 'SUBMITTED' &&
    result.rows[0].correctionReason === null
  )
    throw new ReportError('LOCKED');
}
interface LocationRow {
  id: string;
  projectId: string;
  scopeKey: string;
  n: number;
  siteTimezone: string;
  rawLat: string;
  rawLon: string;
  confirmedAt: Date;
}
const locationDto = (r: LocationRow): WeatherLocationDto => ({
  id: r.id,
  projectId: r.projectId,
  scopeKey: r.scopeKey,
  n: r.n,
  siteTimezone: r.siteTimezone,
  point: { lat: r.rawLat, lon: r.rawLon },
  confirmedAt: iso(r.confirmedAt),
});
const LOCATION_COLUMNS = `id,"projectId","scopeKey",n,"siteTimezone","rawLat","rawLon","confirmedAt"`;
export async function readWeatherLocations(
  client: PoolClient,
  actor: Actor,
  projectId: string,
): Promise<WeatherLocationDto[]> {
  return weatherSafe(async () => {
    await projectWriter(client, actor, projectId);
    return (
      await client.query<LocationRow>(
        `SELECT ${LOCATION_COLUMNS} FROM "WeatherLocationVersion" WHERE "orgId"=$1 AND "projectId"=$2 ORDER BY "scopeKey",n DESC`,
        [actor.orgId, projectId],
      )
    ).rows.map(locationDto);
  });
}
interface RequestRow {
  id: string;
  projectId: string;
  businessDate: string;
  locationVersionId: string;
  state: WeatherRequestDto['state'];
  snapshotId: string | null;
}
const REQUEST_COLUMNS = `r.id,r."projectId",r."businessDate"::text AS "businessDate",r."locationVersionId",r.state,s.id AS "snapshotId"`;
export async function readWeatherRequest(
  client: PoolClient,
  actor: Actor,
  projectId: string,
  requestId: string,
): Promise<WeatherRequestDto> {
  return weatherSafe(async () => {
    await projectWriter(client, actor, projectId);
    const r = await client.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM "WeatherRequest" r LEFT JOIN "WeatherSnapshot" s ON s."orgId"=r."orgId" AND s."requestId"=r.id WHERE r."orgId"=$1 AND r."projectId"=$2 AND r.id=$3`,
      [actor.orgId, projectId, requestId],
    );
    if (!r.rows[0]) throw new ReportError('NOT_FOUND');
    return r.rows[0];
  });
}
export interface WeatherStoredSnapshot {
  id: string;
  data: WeatherReferenceDraftDto;
  adapterVersion: string;
  responseHash: string;
  sourceLink: string;
  licenseLink: string;
}
export async function readWeatherSnapshot(
  client: PoolClient,
  actor: Actor,
  projectId: string,
  snapshotId: string,
): Promise<WeatherStoredSnapshot> {
  return weatherSafe(async () => {
    await projectWriter(client, actor, projectId);
    const r = await client.query<WeatherStoredSnapshot>(
      `SELECT id,data,"adapterVersion","responseHash","sourceLink","licenseLink" FROM "WeatherSnapshot" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3`,
      [actor.orgId, projectId, snapshotId],
    );
    if (!r.rows[0]) throw new ReportError('NOT_FOUND');
    return r.rows[0];
  });
}
export async function resolveWeatherFacts(
  client: PoolClient,
  actor: Actor,
  scope: WeatherDayScope,
  before: WeatherFactsExtension,
  input: WeatherFactsExtension,
  clientMutationId: string,
): Promise<WeatherFactsExtension> {
  return weatherSafe(async () => {
    await writableDay(client, actor, scope);
    const old = parseWeatherFactsExtension(before),
      incoming = parseWeatherFactsExtension(input);
    if (
      Object.hasOwn(incoming, 'reportLocationRef') &&
      JSON.stringify(incoming.reportLocationRef) !==
        JSON.stringify(old.reportLocationRef)
    )
      throw new InvalidReportInput('weather.locationRef');
    const result: WeatherFactsExtension = { ...old };
    if (!Object.hasOwn(incoming, 'weatherReferences')) return result;
    result.weatherReferences = [];
    for (const ref of incoming.weatherReferences ?? []) {
      if (ref.referenceId) {
        const found = await client.query(
          `SELECT id FROM "WeatherReportReference" WHERE "orgId"=$1 AND "projectId"=$2 AND "dailyCloseId"=$3 AND "businessDate"=$4::date AND "siteTimezone"=$5 AND id=$6 AND "snapshotId"=$7 AND "locationVersionId"=$8`,
          [
            actor.orgId,
            scope.projectId,
            scope.dailyCloseId,
            scope.businessDate,
            scope.siteTimezone,
            ref.referenceId,
            ref.snapshotId,
            ref.locationVersionId,
          ],
        );
        if (!found.rows[0]) throw new InvalidReportInput('weather.reference');
        result.weatherReferences.push(ref);
        continue;
      }
      const found = await client.query(
        `SELECT id FROM "WeatherSnapshot" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date AND "siteTimezone"=$4 AND "locationVersionId"=$5 AND id=$6`,
        [
          actor.orgId,
          scope.projectId,
          scope.businessDate,
          scope.siteTimezone,
          ref.locationVersionId,
          ref.snapshotId,
        ],
      );
      if (!found.rows[0]) throw new InvalidReportInput('weather.reference');
      const saved = await client.query<{ id: string }>(
        `INSERT INTO "WeatherReportReference"(id,"orgId","projectId","dailyCloseId","businessDate","siteTimezone","locationVersionId","snapshotId","adoptedByAccountId","adoptedByPersonId","clientMutationId") VALUES($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11) ON CONFLICT("orgId","dailyCloseId","clientMutationId","snapshotId") DO NOTHING RETURNING id`,
        [
          randomUUID(),
          actor.orgId,
          scope.projectId,
          scope.dailyCloseId,
          scope.businessDate,
          scope.siteTimezone,
          ref.locationVersionId,
          ref.snapshotId,
          actor.accountId,
          actor.personId,
          clientMutationId,
        ],
      );
      const referenceId =
        saved.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            `SELECT id FROM "WeatherReportReference" WHERE "orgId"=$1 AND "dailyCloseId"=$2 AND "clientMutationId"=$3 AND "snapshotId"=$4`,
            [actor.orgId, scope.dailyCloseId, clientMutationId, ref.snapshotId],
          )
        ).rows[0]?.id;
      if (!referenceId) throw new WeatherStoreError('WEATHER_STORE_FAILED');
      result.weatherReferences.push({ ...ref, referenceId });
    }
    return result;
  });
}
interface PersonalRow {
  id: string;
  rawAccuracyM: string;
  deviceFixAt: Date | null;
  acquiredAt: Date;
  clientConfirmedAt: Date;
  serverReceivedAt: Date;
}
const safeLocation = (r: PersonalRow): SafeReportLocationRef => ({
  recordId: r.id,
  // Raw text, never NUMERIC's padded projection, is the safe public accuracy representation.
  accuracyM: r.rawAccuracyM,
  deviceFixAt: r.deviceFixAt ? iso(r.deviceFixAt) : null,
  acquiredAt: iso(r.acquiredAt),
  clientConfirmedAt: iso(r.clientConfirmedAt),
  serverReceivedAt: iso(r.serverReceivedAt),
});
const PERSONAL_SAFE = `id,"rawAccuracyM","deviceFixAt","acquiredAt","clientConfirmedAt","serverReceivedAt"`;
async function existingLocation(
  client: PoolClient,
  actor: Actor,
  scope: WeatherDayScope,
  id: string,
) {
  const r = await client.query<PersonalRow>(
    `SELECT ${PERSONAL_SAFE} FROM "ReportLocationRecord" WHERE "orgId"=$1 AND "projectId"=$2 AND "dailyCloseId"=$3 AND "businessDate"=$4::date AND "siteTimezone"=$5 AND id=$6`,
    [
      actor.orgId,
      scope.projectId,
      scope.dailyCloseId,
      scope.businessDate,
      scope.siteTimezone,
      id,
    ],
  );
  if (!r.rows[0]) throw new InvalidReportInput('weather.locationRef');
  return safeLocation(r.rows[0]);
}
export async function writeReportLocation(
  client: PoolClient,
  actor: Actor,
  scope: WeatherDayScope,
  operation: ReportLocationOperation | undefined,
  before: SafeReportLocationRef | null,
  clientMutationId: string,
): Promise<SafeReportLocationRef | null> {
  return weatherSafe(async () => {
    await writableDay(client, actor, scope);
    const previous =
      before === null ? null : parseSafeReportLocationRef(before);
    if (previous) {
      const stored = await existingLocation(
        client,
        actor,
        scope,
        previous.recordId,
      );
      if (JSON.stringify(stored) !== JSON.stringify(previous))
        throw new InvalidReportInput('weather.locationRef');
    }
    if (operation === undefined) return previous;
    const op = parseReportLocationOperation(operation);
    if (op.kind === 'clear') return null;
    const c = op.candidate;
    const saved = await client.query<PersonalRow>(
      `INSERT INTO "ReportLocationRecord"(id,"orgId","projectId","dailyCloseId","businessDate","siteTimezone",lat,lon,"rawLat","rawLon","accuracyM","rawAccuracyM","deviceFixAt","acquiredAt","clientConfirmedAt","actorAccountId","actorPersonId","clientMutationId") VALUES($1,$2,$3,$4,$5::date,$6,($7::text)::numeric,($8::text)::numeric,$7::text,$8::text,($9::text)::numeric,$9::text,$10::timestamptz,$11::timestamptz,$12::timestamptz,$13,$14,$15) RETURNING ${PERSONAL_SAFE}`,
      [
        randomUUID(),
        actor.orgId,
        scope.projectId,
        scope.dailyCloseId,
        scope.businessDate,
        scope.siteTimezone,
        c.lat,
        c.lon,
        c.accuracyM,
        c.deviceFixAt,
        c.acquiredAt,
        op.clientConfirmedAt,
        actor.accountId,
        actor.personId,
        clientMutationId,
      ],
    );
    return safeLocation(saved.rows[0]!);
  });
}
/** Parent registers this exit as coordinates-layer, writer-only. No generic report DTO uses it. */
export async function readReportLocationCoordinates(
  client: PoolClient,
  actor: Actor,
  projectId: string,
  recordId: string,
) {
  return weatherSafe(async () => {
    await projectWriter(client, actor, projectId);
    const r = await client.query<{ lat: string; lon: string }>(
      `SELECT "rawLat" AS lat,"rawLon" AS lon FROM "ReportLocationRecord" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3`,
      [actor.orgId, projectId, recordId],
    );
    if (!r.rows[0]) throw new ReportError('NOT_FOUND');
    return r.rows[0];
  });
}
/** No mutable/live data is fetched: only the adopted immutable snapshot IDs in this scope. */
export async function frozenWeatherReferences(
  client: PoolClient,
  actor: Actor,
  scope: WeatherDayScope,
  refs: WeatherFactsExtension,
): Promise<SafeFrozenWeatherReference[]> {
  return weatherSafe(async () => {
    // Reads still check current project identity; submitted-only callers receive parent's frozen JSON.
    await projectWriter(client, actor, scope.projectId);
    const result: SafeFrozenWeatherReference[] = [];
    for (const ref of parseWeatherFactsExtension(refs).weatherReferences ??
      []) {
      if (!ref.referenceId) throw new InvalidReportInput('weather.reference');
      const rows = await client.query<
        SafeFrozenWeatherReference & { adoptedAt: string }
      >(
        `SELECT r.id AS "referenceId",r."snapshotId",r."locationVersionId",r."adoptedAt",r."adoptedByAccountId",r."adoptedByPersonId",s.data AS snapshot,s."adapterVersion",s."responseHash",s."sourceLink",s."licenseLink" FROM "WeatherReportReference" r JOIN "WeatherSnapshot" s ON s."orgId"=r."orgId" AND s.id=r."snapshotId" WHERE r."orgId"=$1 AND r."projectId"=$2 AND r."dailyCloseId"=$3 AND r."businessDate"=$4::date AND r."siteTimezone"=$5 AND r.id=$6 AND r."locationVersionId"=$7 AND r."snapshotId"=$8`,
        [
          actor.orgId,
          scope.projectId,
          scope.dailyCloseId,
          scope.businessDate,
          scope.siteTimezone,
          ref.referenceId,
          ref.locationVersionId,
          ref.snapshotId,
        ],
      );
      if (!rows.rows[0]) throw new InvalidReportInput('weather.reference');
      result.push({ ...rows.rows[0], adoptedAt: iso(rows.rows[0].adoptedAt) });
    }
    return result;
  });
}
export class WeatherStore {
  constructor(private readonly pool: Pool) {}
  configureLocation(
    identity: Identity,
    input: ConfigureWeatherLocationCommand,
  ): Promise<WeatherLocationDto> {
    return weatherSafe(() =>
      inTransaction(this.pool, identity, async (client, actor) => {
        const command = parseConfigureWeatherLocationCommand(input);
        const project = await projectWriter(client, actor, command.projectId);
        return idempotent(
          client,
          actor,
          'WEATHER_CONFIGURE_LOCATION',
          command.clientMutationId,
          command,
          async () => {
            await client.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [
                `${actor.orgId}:${project.id}:weather-location:${command.scopeKey}`,
              ],
            );
            const latest = (
              await client.query<{ n: number }>(
                `SELECT COALESCE(max(n),0)::integer AS n FROM "WeatherLocationVersion" WHERE "orgId"=$1 AND "projectId"=$2 AND "scopeKey"=$3`,
                [actor.orgId, project.id, command.scopeKey],
              )
            ).rows[0]!.n;
            if (latest !== command.expectedN)
              throw new ReportError('VERSION_CONFLICT');
            const id = randomUUID();
            const rows = await client.query<LocationRow>(
              `INSERT INTO "WeatherLocationVersion"(id,"orgId","projectId","scopeKey",n,"siteTimezone",lat,lon,"rawLat","rawLon","confirmedByAccountId","confirmedByPersonId") VALUES($1,$2,$3,$4,$5,$6,($7::text)::numeric,($8::text)::numeric,$7::text,$8::text,$9,$10) RETURNING ${LOCATION_COLUMNS}`,
              [
                id,
                actor.orgId,
                project.id,
                command.scopeKey,
                latest + 1,
                project.timezone,
                command.point.lat,
                command.point.lon,
                actor.accountId,
                actor.personId,
              ],
            );
            await audit(
              client,
              actor,
              { type: 'WEATHER_LOCATION', id, version: latest + 1 },
              'WEATHER_CONFIGURE_LOCATION',
              '',
              null,
              { id, n: latest + 1 },
              command.clientMutationId,
            );
            return locationDto(rows.rows[0]!);
          },
        );
      }),
    );
  }
  request(
    identity: Identity,
    input: WeatherRequestCommand,
  ): Promise<WeatherRequestDto> {
    return weatherSafe(() =>
      inTransaction(this.pool, identity, async (client, actor) => {
        const command = parseWeatherRequestCommand(input);
        await projectWriter(client, actor, command.projectId);
        return idempotent(
          client,
          actor,
          'WEATHER_REQUEST',
          command.clientMutationId,
          command,
          async () => {
            const row = (
              await client.query<LocationRow>(
                `SELECT ${LOCATION_COLUMNS} FROM "WeatherLocationVersion" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3`,
                [actor.orgId, command.projectId, command.locationVersionId],
              )
            ).rows[0];
            if (!row) throw new ReportError('NOT_FOUND');
            const now = iso(
              (
                await client.query<{ at: Date }>(
                  'SELECT clock_timestamp() AS at',
                )
              ).rows[0]!.at,
            );
            const query = buildWeatherQuery(
              locationDto(row),
              command.businessDate,
              now,
            );
            await client.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [
                `${actor.orgId}:${query.locationVersionId}:${query.businessDate}:${query.timezone}:${query.product}:${query.model}:original`,
              ],
            );
            const previous = (
              await client.query<
                RequestRow & {
                  refreshGeneration: number;
                  fetchedAt: Date | null;
                }
              >(
                `SELECT ${REQUEST_COLUMNS},r."refreshGeneration",s."fetchedAt" FROM "WeatherRequest" r LEFT JOIN "WeatherSnapshot" s ON s."orgId"=r."orgId" AND s."requestId"=r.id WHERE r."orgId"=$1 AND r."projectId"=$2 AND r."locationVersionId"=$3 AND r."businessDate"=$4::date AND r."siteTimezone"=$5 AND r.product=$6 AND r.model=$7 AND r.units='original' ORDER BY r."refreshGeneration" DESC LIMIT 1`,
                [
                  actor.orgId,
                  command.projectId,
                  query.locationVersionId,
                  query.businessDate,
                  query.timezone,
                  query.product,
                  query.model,
                ],
              )
            ).rows[0];
            const active =
              previous &&
              (previous.state === 'PENDING' || previous.state === 'FETCHING');
            const fresh =
              previous?.state === 'READY' &&
              previous.fetchedAt &&
              Date.parse(now) - previous.fetchedAt.getTime() <
                (query.product === 'forecast' ? 3600000 : 86400000);
            if (previous && (active || (!command.refresh && fresh)))
              return {
                id: previous.id,
                projectId: previous.projectId,
                businessDate: previous.businessDate,
                locationVersionId: previous.locationVersionId,
                state: previous.state,
                snapshotId: previous.snapshotId,
              };
            const id = randomUUID(),
              generation = (previous?.refreshGeneration ?? 0) + 1;
            await client.query(
              `INSERT INTO "WeatherRequest"(id,"orgId","projectId","locationVersionId","businessDate","siteTimezone",product,model,"refreshGeneration",query,"requestedByAccountId","requestedByPersonId") VALUES($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12)`,
              [
                id,
                actor.orgId,
                command.projectId,
                query.locationVersionId,
                query.businessDate,
                query.timezone,
                query.product,
                query.model,
                generation,
                JSON.stringify(query),
                actor.accountId,
                actor.personId,
              ],
            );
            await client.query(
              `INSERT INTO "OutboxEvent"(id,"orgId","updatedAt","updatedBy","eventType","aggregateId","aggregateVersion",payload) VALUES($1,$2,clock_timestamp(),$3,'WEATHER_FETCH',$4,$5,$6)`,
              [
                randomUUID(),
                actor.orgId,
                actor.accountId,
                id,
                generation,
                JSON.stringify({ requestId: id }),
              ],
            );
            return {
              id,
              projectId: command.projectId,
              businessDate: query.businessDate,
              locationVersionId: query.locationVersionId,
              state: 'PENDING',
              snapshotId: null,
            };
          },
        );
      }),
    );
  }
}

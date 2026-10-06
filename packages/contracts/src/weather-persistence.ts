import { date, id, InvalidReportInput, obj, str, version } from './parse.js';
import { isRealTimestamp } from './report.js';
import {
  parseReportLocationCandidate,
  parseWeatherQuery,
  type ReportLocationCandidateDto,
  type WeatherQueryDto,
  type WeatherReferenceDraftDto,
} from './weather.js';

export interface WeatherReferenceInput {
  locationVersionId: string;
  snapshotId: string;
  referenceId?: string;
}
export interface SafeReportLocationRef {
  recordId: string;
  accuracyM: string;
  deviceFixAt: string | null;
  acquiredAt: string;
  clientConfirmedAt: string;
  serverReceivedAt: string;
}
export interface WeatherFactsExtension {
  weatherReferences?: WeatherReferenceInput[];
  reportLocationRef?: SafeReportLocationRef | null;
}
export type ReportLocationOperation =
  | {
      kind: 'capture';
      candidate: ReportLocationCandidateDto;
      clientConfirmedAt: string;
    }
  | { kind: 'clear' };
export interface ConfigureWeatherLocationCommand {
  projectId: string;
  scopeKey: string;
  expectedN: number;
  clientMutationId: string;
  point: { lat: string; lon: string };
}
export interface WeatherRequestCommand {
  projectId: string;
  locationVersionId: string;
  businessDate: string;
  refresh: boolean;
  clientMutationId: string;
}
export type WeatherRequestState =
  | 'PENDING'
  | 'FETCHING'
  | 'READY'
  | 'NO_HISTORY'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'DISABLED';
export interface WeatherLocationDto {
  id: string;
  projectId: string;
  scopeKey: string;
  n: number;
  siteTimezone: string;
  point: { lat: string; lon: string };
  confirmedAt: string;
}
export interface WeatherRequestDto {
  id: string;
  projectId: string;
  businessDate: string;
  locationVersionId: string;
  state: WeatherRequestState;
  snapshotId: string | null;
}
export interface WeatherSnapshotDto {
  id: string;
  data: WeatherReferenceDraftDto;
  adapterVersion: string;
  responseHash: string;
  sourceLink: string;
  licenseLink: string;
}
export interface ReportLocationCoordinatesDto {
  lat: string;
  lon: string;
}
export interface SafeFrozenWeatherReference {
  referenceId: string;
  snapshotId: string;
  locationVersionId: string;
  adoptedAt: string;
  adoptedByAccountId: string;
  adoptedByPersonId: string;
  snapshot: WeatherReferenceDraftDto;
  adapterVersion: string;
  responseHash: string;
  sourceLink: string;
  licenseLink: string;
}

function shape(v: unknown, keys: readonly string[], field: string) {
  const o = obj(v, field);
  if (Object.keys(o).some((k) => !keys.includes(k)))
    throw new InvalidReportInput(field);
  return o;
}
function utc(v: unknown, field: string): string {
  const s = str(v, field, 40);
  if (!s.endsWith('Z') || !isRealTimestamp(s))
    throw new InvalidReportInput(field);
  return s;
}
export function parseSafeReportLocationRef(v: unknown): SafeReportLocationRef {
  const o = shape(
    v,
    [
      'recordId',
      'accuracyM',
      'deviceFixAt',
      'acquiredAt',
      'clientConfirmedAt',
      'serverReceivedAt',
    ],
    'weather.locationRef',
  );
  const accuracyM = str(o['accuracyM'], 'weather.locationRef.accuracyM', 16);
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(accuracyM))
    throw new InvalidReportInput('weather.locationRef.accuracyM');
  return {
    recordId: id(o['recordId'], 'weather.locationRef.recordId'),
    accuracyM,
    deviceFixAt:
      o['deviceFixAt'] === null
        ? null
        : utc(o['deviceFixAt'], 'weather.locationRef.deviceFixAt'),
    acquiredAt: utc(o['acquiredAt'], 'weather.locationRef.acquiredAt'),
    clientConfirmedAt: utc(
      o['clientConfirmedAt'],
      'weather.locationRef.clientConfirmedAt',
    ),
    serverReceivedAt: utc(
      o['serverReceivedAt'],
      'weather.locationRef.serverReceivedAt',
    ),
  };
}
export function parseWeatherFactsExtension(v: unknown): WeatherFactsExtension {
  const o = shape(
    v,
    ['weatherReferences', 'reportLocationRef'],
    'weather.extensions',
  );
  const result: WeatherFactsExtension = {};
  if (Object.hasOwn(o, 'weatherReferences')) {
    const refs = o['weatherReferences'];
    if (!Array.isArray(refs) || refs.length > 20)
      throw new InvalidReportInput('weather.references');
    result.weatherReferences = refs.map((v) => {
      const r = shape(
        v,
        ['locationVersionId', 'snapshotId', 'referenceId'],
        'weather.reference',
      );
      return {
        locationVersionId: id(
          r['locationVersionId'],
          'weather.reference.location',
        ),
        snapshotId: id(r['snapshotId'], 'weather.reference.snapshot'),
        ...(Object.hasOwn(r, 'referenceId')
          ? { referenceId: id(r['referenceId'], 'weather.reference.id') }
          : {}),
      };
    });
    if (
      new Set(result.weatherReferences.map((r) => r.snapshotId)).size !==
      refs.length
    )
      throw new InvalidReportInput('weather.references');
  }
  if (Object.hasOwn(o, 'reportLocationRef'))
    result.reportLocationRef =
      o['reportLocationRef'] === null
        ? null
        : parseSafeReportLocationRef(o['reportLocationRef']);
  return result;
}
export function parseReportLocationOperation(
  v: unknown,
): ReportLocationOperation {
  const o = obj(v, 'weather.locationOperation');
  if (o['kind'] === 'clear') {
    shape(v, ['kind'], 'weather.locationOperation');
    return { kind: 'clear' };
  }
  shape(
    v,
    ['kind', 'candidate', 'clientConfirmedAt'],
    'weather.locationOperation',
  );
  if (o['kind'] !== 'capture')
    throw new InvalidReportInput('weather.locationOperation');
  return {
    kind: 'capture',
    candidate: parseReportLocationCandidate(o['candidate']),
    clientConfirmedAt: utc(
      o['clientConfirmedAt'],
      'weather.locationOperation.clientConfirmedAt',
    ),
  };
}
export function parseConfigureWeatherLocationCommand(
  v: unknown,
): ConfigureWeatherLocationCommand {
  const o = shape(
    v,
    ['projectId', 'scopeKey', 'expectedN', 'clientMutationId', 'point'],
    'weather.configure',
  );
  const p = shape(o['point'], ['lat', 'lon'], 'weather.configure.point');
  const checked = parseReportLocationCandidate({
    ...p,
    accuracyM: '0',
    deviceFixAt: null,
    acquiredAt: '2000-01-01T00:00:00Z',
  });
  const scopeKey = str(o['scopeKey'], 'weather.configure.scopeKey', 64);
  if (!/^[A-Za-z][\w-]{0,63}$/.test(scopeKey))
    throw new InvalidReportInput('weather.configure.scopeKey');
  return {
    projectId: id(o['projectId'], 'projectId'),
    scopeKey,
    expectedN: version(o['expectedN'], 'weather.configure.expectedN'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    point: { lat: checked.lat, lon: checked.lon },
  };
}
export function parseWeatherRequestCommand(v: unknown): WeatherRequestCommand {
  const o = shape(
    v,
    [
      'projectId',
      'locationVersionId',
      'businessDate',
      'refresh',
      'clientMutationId',
    ],
    'weather.request',
  );
  if (typeof o['refresh'] !== 'boolean')
    throw new InvalidReportInput('weather.request.refresh');
  return {
    projectId: id(o['projectId'], 'projectId'),
    locationVersionId: id(
      o['locationVersionId'],
      'weather.request.locationVersionId',
    ),
    businessDate: date(o['businessDate'], 'businessDate'),
    refresh: o['refresh'],
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
/** Resolve civil midnights, not 24h durations. Unsupported/skipped local dates fail visibly. */
export function weatherDayInterval(
  businessDate: string,
  timezone: string,
): { startAt: string; endAt: string } {
  date(businessDate, 'businessDate');
  const midnight = (day: string) => {
    const target = Date.parse(day + 'T00:00:00Z');
    let candidate = target;
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      for (let i = 0; i < 5; i++) {
        const parts = formatter.formatToParts(new Date(candidate));
        const get = (key: string) => parts.find((p) => p.type === key)?.value;
        const rendered = Date.parse(
          `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`,
        );
        if (rendered === target) return new Date(candidate).toISOString();
        candidate += target - rendered;
      }
    } catch {
      throw new InvalidReportInput('weather.timezone');
    }
    throw new InvalidReportInput('weather.dayInterval');
  };
  const next = new Date(Date.parse(businessDate + 'T00:00:00Z') + 86400000)
    .toISOString()
    .slice(0, 10);
  return { startAt: midnight(businessDate), endAt: midnight(next) };
}
export function buildWeatherQuery(
  location: WeatherLocationDto,
  businessDate: string,
  now: string,
): WeatherQueryDto {
  const interval = weatherDayInterval(businessDate, location.siteTimezone);
  const past =
    Date.parse(interval.endAt) <= Date.parse(utc(now, 'weather.now'));
  return parseWeatherQuery(
    {
      projectId: location.projectId,
      locationVersionId: location.id,
      businessDate,
      timezone: location.siteTimezone,
      point: location.point,
      interval,
      product: past ? 'historical-weather' : 'forecast',
      model: past ? 'era5' : 'forecast',
    },
    now,
  );
}

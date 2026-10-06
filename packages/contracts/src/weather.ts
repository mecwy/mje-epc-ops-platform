/** Weather references are independent of reported weather, attendance and work permission. */
import { date, id, oneOf, str, InvalidReportInput, obj } from './parse.js';
import { isRealTimestamp } from './report.js';

export type WeatherValueDto =
  | { state: 'value'; value: string; raw: string; unit: string }
  | {
      state: 'blank' | 'missing' | 'unknown' | 'not_applicable';
      raw: string | null;
      unit: string | null;
      reason: string;
    };
export interface WeatherQueryDto {
  projectId: string;
  locationVersionId: string;
  businessDate: string;
  timezone: string;
  point: { lat: string; lon: string };
  interval: { startAt: string; endAt: string };
  product: 'historical-weather' | 'forecast';
  model: 'era5' | 'ifs' | 'forecast';
}
export const WEATHER_METRICS = [
  'condition',
  'temperatureMin',
  'temperatureMax',
  'precipitation',
  'windMax',
  'gustMax',
] as const;
export type WeatherMetric = (typeof WEATHER_METRICS)[number];
/** A backend draft; database identity/adoption actor are added by the protected store. */
export interface WeatherReferenceDraftDto {
  provider: 'open-meteo';
  query: WeatherQueryDto;
  category: 'reanalysis' | 'analysis' | 'forecast';
  fetchedAt: string;
  publishedAt: string | null;
  coverage: 'complete' | 'partial';
  grid: { lat: string; lon: string } | null;
  metrics: Record<WeatherMetric, WeatherValueDto>;
}
export interface ReportLocationCandidateDto {
  lat: string;
  lon: string;
  accuracyM: string;
  deviceFixAt: string | null;
  acquiredAt: string;
}

function shape(v: unknown, keys: readonly string[], field: string) {
  const o = obj(v, field);
  if (Object.keys(o).some((key) => !keys.includes(key)))
    throw new InvalidReportInput(field);
  return o;
}
function utc(v: unknown, field: string): string {
  const s = str(v, field, 40);
  if (!s.endsWith('Z') || !isRealTimestamp(s))
    throw new InvalidReportInput(field);
  return s;
}
function point(v: unknown, field: string) {
  const o = shape(v, ['lat', 'lon'], field);
  const coord = (key: 'lat' | 'lon', limit: number) => {
    const s = str(o[key], `${field}.${key}`, 32);
    if (!/^-?\d{1,3}(?:\.\d{1,12})?$/.test(s) || Math.abs(Number(s)) > limit)
      throw new InvalidReportInput(`${field}.${key}`);
    return s;
  };
  return { lat: coord('lat', 90), lon: coord('lon', 180) };
}
function localParts(at: string, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const get = (key: string) => parts.find((p) => p.type === key)?.value;
    return {
      day: `${get('year')}-${get('month')}-${get('day')}`,
      midnight:
        get('hour') === '00' &&
        get('minute') === '00' &&
        get('second') === '00' &&
        new Date(at).getUTCMilliseconds() === 0,
    };
  } catch {
    throw new InvalidReportInput('weather.query.timezone');
  }
}
/** now is supplied by the backend: the transport receipt date never replaces businessDate. */
export function parseWeatherQuery(v: unknown, now: string): WeatherQueryDto {
  const o = shape(
    v,
    [
      'projectId',
      'locationVersionId',
      'businessDate',
      'timezone',
      'point',
      'interval',
      'product',
      'model',
    ],
    'weather.query',
  );
  const businessDate = date(o['businessDate'], 'weather.query.businessDate');
  const timezone = str(o['timezone'], 'weather.query.timezone', 100);
  const range = shape(
    o['interval'],
    ['startAt', 'endAt'],
    'weather.query.interval',
  );
  const startAt = utc(range['startAt'], 'weather.query.interval.startAt');
  const endAt = utc(range['endAt'], 'weather.query.interval.endAt');
  const nextDay = new Date(
    new Date(`${businessDate}T00:00:00Z`).getTime() + 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const start = localParts(startAt, timezone);
  const end = localParts(endAt, timezone);
  if (
    !start.midnight ||
    !end.midnight ||
    start.day !== businessDate ||
    end.day !== nextDay ||
    Date.parse(endAt) <= Date.parse(startAt)
  )
    throw new InvalidReportInput('weather.query.interval');
  const product = oneOf(
    o['product'],
    ['historical-weather', 'forecast'] as const,
    'weather.query.product',
  );
  const model = oneOf(
    o['model'],
    ['era5', 'ifs', 'forecast'] as const,
    'weather.query.model',
  );
  const pastDay =
    Date.parse(endAt) <= Date.parse(utc(now, 'weather.query.now'));
  if (
    (product === 'historical-weather') !== pastDay ||
    (product === 'forecast') !== (model === 'forecast')
  )
    throw new InvalidReportInput('weather.query.product');
  return {
    projectId: id(o['projectId'], 'weather.query.projectId'),
    locationVersionId: id(
      o['locationVersionId'],
      'weather.query.locationVersionId',
    ),
    businessDate,
    timezone,
    point: point(o['point'], 'weather.query.point'),
    interval: { startAt, endAt },
    product,
    model,
  };
}
export function weatherCategory(
  q: WeatherQueryDto,
): WeatherReferenceDraftDto['category'] {
  return q.model === 'era5'
    ? 'reanalysis'
    : q.model === 'ifs'
      ? 'analysis'
      : 'forecast';
}
export function parseWeatherValue(v: unknown): WeatherValueDto {
  const o = obj(v, 'weather.value');
  const state = oneOf(
    o['state'],
    ['value', 'blank', 'missing', 'unknown', 'not_applicable'] as const,
    'weather.value.state',
  );
  if (state === 'value') {
    shape(v, ['state', 'value', 'raw', 'unit'], 'weather.value');
    const value = str(o['value'], 'weather.value.value', 64);
    if (
      !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) ||
      !Number.isFinite(Number(value))
    )
      throw new InvalidReportInput('weather.value.value');
    const unit = str(o['unit'], 'weather.value.unit', 40);
    if (!unit) throw new InvalidReportInput('weather.value.unit');
    return { state, value, raw: str(o['raw'], 'weather.value.raw', 100), unit };
  }
  shape(v, ['state', 'raw', 'unit', 'reason'], 'weather.value');
  const raw =
    o['raw'] === null ? null : str(o['raw'], 'weather.value.raw', 100);
  const unit =
    o['unit'] === null ? null : str(o['unit'], 'weather.value.unit', 40);
  const reason = str(o['reason'], 'weather.value.reason', 100);
  if (
    !reason ||
    (state === 'blank' && raw !== '') ||
    (state === 'missing' && raw !== null)
  )
    throw new InvalidReportInput('weather.value');
  return { state, raw, unit, reason };
}
export function parseWeatherReferenceDraft(
  v: unknown,
): WeatherReferenceDraftDto {
  const o = shape(
    v,
    [
      'provider',
      'query',
      'category',
      'fetchedAt',
      'publishedAt',
      'coverage',
      'grid',
      'metrics',
    ],
    'weather.reference',
  );
  const fetchedAt = utc(o['fetchedAt'], 'weather.reference.fetchedAt');
  const query = parseWeatherQuery(o['query'], fetchedAt);
  const category = oneOf(
    o['category'],
    ['reanalysis', 'analysis', 'forecast'] as const,
    'weather.reference.category',
  );
  if (category !== weatherCategory(query))
    throw new InvalidReportInput('weather.reference.category');
  const input = shape(
    o['metrics'],
    WEATHER_METRICS,
    'weather.reference.metrics',
  );
  const metrics = Object.fromEntries(
    WEATHER_METRICS.map((key) => [key, parseWeatherValue(input[key])]),
  ) as Record<WeatherMetric, WeatherValueDto>;
  const complete = WEATHER_METRICS.every(
    (key) => metrics[key].state === 'value',
  );
  const coverage = oneOf(
    o['coverage'],
    ['complete', 'partial'] as const,
    'weather.reference.coverage',
  );
  if (coverage === 'complete' && !complete)
    throw new InvalidReportInput('weather.reference.coverage');
  return {
    provider: oneOf(
      o['provider'],
      ['open-meteo'] as const,
      'weather.reference.provider',
    ),
    query,
    category,
    fetchedAt,
    publishedAt:
      o['publishedAt'] === null
        ? null
        : utc(o['publishedAt'], 'weather.reference.publishedAt'),
    coverage,
    grid:
      o['grid'] === null ? null : point(o['grid'], 'weather.reference.grid'),
    metrics,
  };
}
/** The backend supplies serverReceivedAt separately; unknown device time is never filled. */
export function parseReportLocationCandidate(
  v: unknown,
): ReportLocationCandidateDto {
  const o = shape(
    v,
    ['lat', 'lon', 'accuracyM', 'deviceFixAt', 'acquiredAt'],
    'weather.reportLocation',
  );
  const coords = point(
    { lat: o['lat'], lon: o['lon'] },
    'weather.reportLocation',
  );
  const accuracyM = str(o['accuracyM'], 'weather.reportLocation.accuracyM', 16);
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(accuracyM))
    throw new InvalidReportInput('weather.reportLocation.accuracyM');
  return {
    ...coords,
    accuracyM,
    deviceFixAt:
      o['deviceFixAt'] === null
        ? null
        : utc(o['deviceFixAt'], 'weather.reportLocation.deviceFixAt'),
    acquiredAt: utc(o['acquiredAt'], 'weather.reportLocation.acquiredAt'),
  };
}

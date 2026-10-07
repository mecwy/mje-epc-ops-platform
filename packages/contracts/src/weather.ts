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
export interface MetForecastDto {
  /** MET update time is not a model-run/publication time. All times are UTC. */
  providerUpdatedAt: string;
  outboundPoint: { lat: string; lon: string };
  returnedPoint: { lat: string; lon: string };
  coveredInterval: { startAt: string; endAt: string };
  instants: Array<{
    at: string;
    airTemperature: WeatherValueDto;
    windSpeed: WeatherValueDto;
    gust: WeatherValueDto;
  }>;
  /** Separate overlapping provider periods; never sum 1/6/12-hour products. */
  periods: Array<{
    startAt: string;
    endAt: string;
    hours: 1 | 6 | 12;
    symbolCode: string | null;
    precipitation: WeatherValueDto;
  }>;
}
interface WeatherReferenceBase {
  query: WeatherQueryDto;
  category: 'reanalysis' | 'analysis' | 'forecast';
  fetchedAt: string;
  publishedAt: string | null;
  coverage: 'complete' | 'partial';
  grid: { lat: string; lon: string } | null;
  metrics: Record<WeatherMetric, WeatherValueDto>;
}
export type WeatherReferenceDraftDto = WeatherReferenceBase &
  (
    | { provider: 'open-meteo'; forecast?: never }
    | { provider: 'met-norway'; forecast: MetForecastDto }
  );
/** Provider normalization truncates outward request precision, never the stored site point. */
export function metForecastPoint(input: { lat: string; lon: string }) {
  const p = point(input, 'weather.forecast.outboundPoint');
  const truncate = (s: string) => {
    const negative = s.startsWith('-');
    const [whole = '0', fraction = ''] = (negative ? s.slice(1) : s).split('.');
    const text = `${BigInt(whole)}.${fraction.slice(0, 4).padEnd(4, '0')}`;
    return negative && /[1-9]/.test(text) ? `-${text}` : text;
  };
  return { lat: truncate(p.lat), lon: truncate(p.lon) };
}
function parseMetForecast(v: unknown, q: WeatherQueryDto): MetForecastDto {
  const o = shape(
    v,
    [
      'providerUpdatedAt',
      'outboundPoint',
      'returnedPoint',
      'coveredInterval',
      'instants',
      'periods',
    ],
    'weather.forecast',
  );
  const outboundPoint = point(
    o['outboundPoint'],
    'weather.forecast.outboundPoint',
  );
  const expected = metForecastPoint(q.point);
  if (outboundPoint.lat !== expected.lat || outboundPoint.lon !== expected.lon)
    throw new InvalidReportInput('weather.forecast.outboundPoint');
  const covered = shape(
    o['coveredInterval'],
    ['startAt', 'endAt'],
    'weather.forecast.coveredInterval',
  );
  const startAt = utc(covered['startAt'], 'weather.forecast.startAt');
  const endAt = utc(covered['endAt'], 'weather.forecast.endAt');
  const start = Date.parse(startAt),
    end = Date.parse(endAt);
  const dayStart = Date.parse(q.interval.startAt),
    dayEnd = Date.parse(q.interval.endAt);
  if (start < dayStart || end > dayEnd || end <= start)
    throw new InvalidReportInput('weather.forecast.coveredInterval');
  const inputInstants = o['instants'],
    inputPeriods = o['periods'];
  if (
    !Array.isArray(inputInstants) ||
    inputInstants.length === 0 ||
    inputInstants.length > 96 ||
    !Array.isArray(inputPeriods) ||
    inputPeriods.length > 288
  )
    throw new InvalidReportInput('weather.forecast.series');
  let previous = -Infinity;
  const instants = inputInstants.map((v) => {
    const i = shape(
      v,
      ['at', 'airTemperature', 'windSpeed', 'gust'],
      'weather.forecast.instant',
    );
    const at = utc(i['at'], 'weather.forecast.at'),
      ms = Date.parse(at);
    if (ms <= previous || ms < start || ms >= end)
      throw new InvalidReportInput('weather.forecast.at');
    previous = ms;
    return {
      at,
      airTemperature: parseWeatherValue(i['airTemperature']),
      windSpeed: parseWeatherValue(i['windSpeed']),
      gust: parseWeatherValue(i['gust']),
    };
  });
  const keys = new Set<string>();
  const periods = inputPeriods.map((v): MetForecastDto['periods'][number] => {
    const p = shape(
      v,
      ['startAt', 'endAt', 'hours', 'symbolCode', 'precipitation'],
      'weather.forecast.period',
    );
    const ps = utc(p['startAt'], 'weather.forecast.period.startAt'),
      pe = utc(p['endAt'], 'weather.forecast.period.endAt');
    const hours = p['hours'];
    if (hours !== 1 && hours !== 6 && hours !== 12)
      throw new InvalidReportInput('weather.forecast.hours');
    const key = `${ps}/${hours}`;
    if (
      keys.has(key) ||
      !instants.some((i) => i.at === ps) ||
      Date.parse(pe) - Date.parse(ps) !== hours * 3600000
    )
      throw new InvalidReportInput('weather.forecast.period');
    keys.add(key);
    const symbolCode =
      p['symbolCode'] === null
        ? null
        : str(p['symbolCode'], 'weather.forecast.symbolCode', 100);
    if (symbolCode !== null && !/^[a-z][a-z0-9_]*$/.test(symbolCode))
      throw new InvalidReportInput('weather.forecast.symbolCode');
    return {
      startAt: ps,
      endAt: pe,
      hours,
      symbolCode,
      precipitation: parseWeatherValue(p['precipitation']),
    };
  });
  const actualStart = instants[0]!.at;
  const actualEnd = Math.min(
    dayEnd,
    Math.max(
      ...instants.map((i) => Date.parse(i.at) + 1),
      ...periods.map((p) => Date.parse(p.endAt)),
    ),
  );
  if (startAt !== actualStart || end !== actualEnd)
    throw new InvalidReportInput('weather.forecast.coveredInterval');
  return {
    providerUpdatedAt: utc(
      o['providerUpdatedAt'],
      'weather.forecast.providerUpdatedAt',
    ),
    outboundPoint,
    returnedPoint: point(o['returnedPoint'], 'weather.forecast.returnedPoint'),
    coveredInterval: { startAt, endAt },
    instants,
    periods,
  };
}

export interface ReportLocationCandidateDto {
  /** Original decimal text; finite browser Number notation is expanded without rounding. */
  lat: string;
  lon: string;
  accuracyM: string;
  deviceFixAt: string | null;
  acquiredAt: string;
}

/** IEEE-754 native readings can have 324 fractional places (5e-324). */
function nativeDecimal(
  v: unknown,
  field: string,
  integerDigits: number,
  limit: bigint,
  signed: boolean,
): string {
  const s = str(v, field, integerDigits + 326);
  if (!new RegExp(`^-?\\d{1,${integerDigits}}(?:\\.\\d{1,324})?$`).test(s))
    throw new InvalidReportInput(field);
  const unsigned = s.startsWith('-') ? s.slice(1) : s;
  const [integer = '', fraction = ''] = unsigned.split('.');
  const whole = BigInt(integer);
  const nonzeroFraction = /[1-9]/.test(fraction);
  if (
    whole > limit ||
    (whole === limit && nonzeroFraction) ||
    (!signed && s.startsWith('-') && (whole !== 0n || nonzeroFraction))
  )
    throw new InvalidReportInput(field);
  return s;
}

/** Raw precision is shared by the capture command and safe historical accuracy metadata. */
export function parseReportLocationAccuracy(
  v: unknown,
  field = 'weather.reportLocation.accuracyM',
): string {
  return nativeDecimal(v, field, 6, 1000000n, false);
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
      ...(obj(v, 'weather.reference')['provider'] === 'met-norway'
        ? ['forecast']
        : []),
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
  const provider = oneOf(
    o['provider'],
    ['open-meteo', 'met-norway'] as const,
    'weather.reference.provider',
  );
  const common = {
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
  if (provider === 'open-meteo') return { ...common, provider };
  if (
    query.product !== 'forecast' ||
    category !== 'forecast' ||
    coverage !== 'partial' ||
    common.grid !== null ||
    common.publishedAt !== null ||
    WEATHER_METRICS.some((key) => metrics[key].state !== 'not_applicable')
  )
    throw new InvalidReportInput('weather.forecast');
  return {
    ...common,
    provider,
    forecast: parseMetForecast(o['forecast'], query),
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
  const coords = {
    lat: nativeDecimal(o['lat'], 'weather.reportLocation.lat', 3, 90n, true),
    lon: nativeDecimal(o['lon'], 'weather.reportLocation.lon', 3, 180n, true),
  };
  const accuracyM = parseReportLocationAccuracy(o['accuracyM']);
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

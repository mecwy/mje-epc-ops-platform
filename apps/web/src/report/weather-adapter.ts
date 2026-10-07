import {
  isRealTimestamp,
  parseReportLocationCandidate,
  parseWeatherReferenceDraft,
  WEATHER_METRICS,
  type ReportLocationCandidateDto,
  type SafeFrozenWeatherReference,
  type MetForecastDto,
} from '@mje/contracts';
import {
  acquirePosition,
  type GeoReading,
  type GeoSource,
  type Timers,
} from './geo.js';
import type {
  LocateInput,
  WeatherLocationDependencies,
  WeatherReferenceView,
} from './weather-location-session.js';

/** These ports are opt-in TEST seams. The application defaults never request GPS or a provider. */
export interface WeatherPresentationPorts {
  locationVersionId?: string | null;
  loadWeather?: WeatherLocationDependencies['loadWeather'];
  locate?: WeatherLocationDependencies['locate'];
}
export const disabledWeatherPorts = {
  loadWeather: async (): Promise<WeatherReferenceView> => {
    throw new Error('WEATHER_DISABLED');
  },
  locate: async (): Promise<LocateInput> => ({ kind: 'unsupported' }),
};
/** Expand exponent notation without changing or rounding its numeric digits. */
function decimalText(value: number): string {
  if (Object.is(value, -0)) return '-0';
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(text);
  if (!match) return text;
  const digits = `${match[2]}${match[3] ?? ''}`;
  const point = match[2]!.length + Number(match[4]);
  return (
    match[1] +
    (point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`)
  );
}

/** C03 has its own precision contract; no check-in rounding or timestamp substitution. */
export function reportLocationReading(
  reading: GeoReading,
  acquiredAt: number,
): ReportLocationCandidateDto | null {
  try {
    const deviceFixAt =
      Number.isFinite(reading.timestamp) && reading.timestamp > 0
        ? new Date(reading.timestamp).toISOString()
        : null;
    return parseReportLocationCandidate({
      lat: decimalText(reading.coords.latitude),
      lon: decimalText(reading.coords.longitude),
      accuracyM: decimalText(reading.coords.accuracy),
      deviceFixAt,
      acquiredAt: new Date(acquiredAt).toISOString(),
    });
  } catch {
    return null;
  }
}
export async function locateReportLocation(
  geo: GeoSource | null | undefined,
  signal: AbortSignal,
  timers?: Timers,
): Promise<LocateInput> {
  const result = await acquirePosition(
    geo,
    reportLocationReading,
    timers,
    signal,
  );
  return result.fix
    ? { kind: 'fix', reading: result.fix }
    : { kind: result.reason === 'noFix' ? 'unavailable' : result.reason };
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Validate the safe frozen wrapper; nested data uses the canonical shared codec. */
export function parseFrozenWeatherReferences(
  input: unknown,
  projectId?: string,
  businessDate?: string,
): SafeFrozenWeatherReference[] {
  if (!Array.isArray(input) || input.length > 100)
    throw new Error('INVALID_WEATHER_RESPONSE');
  return input.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('INVALID_WEATHER_RESPONSE');
    const o = value as Record<string, unknown>;
    const keys = [
      'referenceId',
      'snapshotId',
      'locationVersionId',
      'adoptedAt',
      'adoptedByAccountId',
      'adoptedByPersonId',
      'snapshot',
      'adapterVersion',
      'responseHash',
      'sourceLink',
      'licenseLink',
    ];
    if (
      Object.keys(o).length !== keys.length ||
      Object.keys(o).some((k) => !keys.includes(k))
    )
      throw new Error('INVALID_WEATHER_RESPONSE');
    const uuid = (key: string) => {
      const v = o[key];
      if (typeof v !== 'string' || !UUID.test(v))
        throw new Error('INVALID_WEATHER_RESPONSE');
      return v;
    };
    const text = (key: string, max: number) => {
      const v = o[key];
      if (typeof v !== 'string' || !v || v.length > max)
        throw new Error('INVALID_WEATHER_RESPONSE');
      return v;
    };
    const adoptedAt = text('adoptedAt', 40);
    if (!adoptedAt.endsWith('Z') || !isRealTimestamp(adoptedAt))
      throw new Error('INVALID_WEATHER_RESPONSE');
    const snapshot = parseWeatherReferenceDraft(o['snapshot']);
    const locationVersionId = uuid('locationVersionId');
    if (
      snapshot.query.locationVersionId !== locationVersionId ||
      (projectId !== undefined && snapshot.query.projectId !== projectId) ||
      (businessDate !== undefined &&
        snapshot.query.businessDate !== businessDate)
    )
      throw new Error('INVALID_WEATHER_RESPONSE');
    return {
      referenceId: uuid('referenceId'),
      snapshotId: uuid('snapshotId'),
      locationVersionId,
      adoptedAt,
      adoptedByAccountId: uuid('adoptedByAccountId'),
      adoptedByPersonId: uuid('adoptedByPersonId'),
      snapshot,
      adapterVersion: text('adapterVersion', 100),
      responseHash: text('responseHash', 128),
      sourceLink: text('sourceLink', 2000),
      licenseLink: text('licenseLink', 2000),
    };
  });
}

export type ProviderWeatherReferenceView = Omit<
  WeatherReferenceView,
  'source' | 'forecast'
> &
  (
    | { source: 'open-meteo'; forecast?: never }
    | { source: 'met-norway'; forecast: MetForecastDto }
  );

export function weatherReferenceView(
  reference: SafeFrozenWeatherReference,
): ProviderWeatherReferenceView {
  const data = reference.snapshot;
  const common = {
    projectId: data.query.projectId,
    businessDate: data.query.businessDate,
    timezone: data.query.timezone,
    locationVersionId: reference.locationVersionId,
    snapshotId: reference.snapshotId,
    category: data.category,
    fetchedAt: data.fetchedAt,
    publishedAt: data.publishedAt,
    interval: structuredClone(data.query.interval),
    coverage: data.coverage,
    stale: false,
    sourceLink: reference.sourceLink,
    licenseLink: reference.licenseLink,
    values: WEATHER_METRICS.map((key) => {
      const metric = data.metrics[key];
      return {
        label: key,
        state: metric.state,
        value: metric.state === 'value' ? metric.value : null,
        unit: metric.unit,
      };
    }),
  };
  return data.provider === 'met-norway'
    ? {
        ...common,
        source: data.provider,
        forecast: structuredClone(data.forecast),
      }
    : { ...common, source: data.provider };
}

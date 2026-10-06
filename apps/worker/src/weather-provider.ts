/** No default HTTP transport: activation, authorization and persistence belong to the caller. */
import { weatherCategory, type WeatherQueryDto } from '@mje/contracts';
export type OpenMeteoQuery = WeatherQueryDto;
export class WeatherProviderError extends Error {
  constructor(
    readonly code:
      | 'WEATHER_UNAVAILABLE'
      | 'WEATHER_RATE_LIMITED'
      | 'WEATHER_INVALID_RESPONSE'
      | 'WEATHER_CANCELLED',
  ) {
    super(code);
    this.name = 'WeatherProviderError';
  }
}
export interface WeatherProviderDependencies<T> {
  /** Supply the authoritative contracts decoder when the package export is integrated. */
  acceptQuery: (input: unknown, now: string) => OpenMeteoQuery;
  acceptReference: (draft: unknown) => T;
  transport: (
    query: Readonly<OpenMeteoQuery>,
    signal: AbortSignal,
  ) => Promise<{ status: number; body: unknown }>;
  now: () => string;
}
const METRICS = {
  condition: 'weather_code',
  temperatureMin: 'temperature_2m_min',
  temperatureMax: 'temperature_2m_max',
  precipitation: 'precipitation_sum',
  windMax: 'wind_speed_10m_max',
  gustMax: 'wind_gusts_10m_max',
} as const;
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new WeatherProviderError('WEATHER_INVALID_RESPONSE');
  return v as Record<string, unknown>;
}
function scalarValue(
  day: Record<string, unknown>,
  units: Record<string, unknown>,
  key: string,
) {
  const unit =
    typeof units[key] === 'string' && units[key] !== '' ? units[key] : null;
  if (!Object.hasOwn(day, key))
    return { state: 'missing', raw: null, unit, reason: 'not_provided' };
  const values = day[key];
  if (!Array.isArray(values) || values.length !== 1)
    throw new WeatherProviderError('WEATHER_INVALID_RESPONSE');
  const value: unknown = values[0];
  if (value === null)
    return { state: 'missing', raw: null, unit, reason: 'provider_null' };
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new WeatherProviderError('WEATHER_INVALID_RESPONSE');
  if (unit === null)
    return {
      state: 'unknown',
      raw: String(value),
      unit,
      reason: 'unit_missing',
    };
  return { state: 'value', value: String(value), raw: String(value), unit };
}
/** Parses one explicitly requested local-day product; currentConditions is never a fallback. */
export function parseOpenMeteoDaily(
  body: unknown,
  query: OpenMeteoQuery,
  fetchedAt: string,
): unknown {
  const response = object(body);
  const daily = object(response['daily']);
  const times = daily['time'];
  if (
    !Array.isArray(times) ||
    times.length !== 1 ||
    times[0] !== query.businessDate ||
    response['timezone'] !== query.timezone
  )
    throw new WeatherProviderError('WEATHER_INVALID_RESPONSE');
  const units =
    response['daily_units'] === undefined
      ? {}
      : object(response['daily_units']);
  const metrics = Object.fromEntries(
    Object.entries(METRICS).map(([name, key]) => [
      name,
      scalarValue(daily, units, key),
    ]),
  );
  const lat = response['latitude'];
  const lon = response['longitude'];
  if (
    (lat !== undefined || lon !== undefined) &&
    (typeof lat !== 'number' ||
      !Number.isFinite(lat) ||
      typeof lon !== 'number' ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180)
  )
    throw new WeatherProviderError('WEATHER_INVALID_RESPONSE');
  return {
    provider: 'open-meteo',
    query,
    category: weatherCategory(query),
    fetchedAt,
    publishedAt: null,
    coverage: Object.values(metrics).every((v) => v.state === 'value')
      ? 'complete'
      : 'partial',
    grid: lat === undefined ? null : { lat: String(lat), lon: String(lon) },
    metrics,
  };
}
export async function fetchOpenMeteo<T>(
  input: unknown,
  dependencies: WeatherProviderDependencies<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new WeatherProviderError('WEATHER_CANCELLED');
  // Validate before transport; the adapter cannot turn a past-day query into a current one.
  const query = structuredClone(
    dependencies.acceptQuery(input, dependencies.now()),
  );
  let response: { status: number; body: unknown };
  try {
    response = await dependencies.transport(structuredClone(query), signal);
  } catch {
    throw new WeatherProviderError(
      signal.aborted ? 'WEATHER_CANCELLED' : 'WEATHER_UNAVAILABLE',
    );
  }
  if (signal.aborted) throw new WeatherProviderError('WEATHER_CANCELLED');
  if (response.status === 429)
    throw new WeatherProviderError('WEATHER_RATE_LIMITED');
  if (response.status !== 200)
    throw new WeatherProviderError('WEATHER_UNAVAILABLE');
  try {
    return dependencies.acceptReference(
      parseOpenMeteoDaily(response.body, query, dependencies.now()),
    );
  } catch {
    // Neither external error bodies nor rejected coordinates leak through the error envelope.
    throw new WeatherProviderError('WEATHER_INVALID_RESPONSE');
  }
}

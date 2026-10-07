/** Pure MET Locationforecast decoder. No HTTP, credentials, persistence or implicit activation. */
import {
  metForecastPoint,
  parseWeatherQuery,
  parseWeatherReferenceDraft,
  WEATHER_METRICS,
  type MetForecastDto,
  type WeatherQueryDto,
  type WeatherReferenceDraftDto,
  type WeatherValueDto,
} from '@mje/contracts';
export class MetNorwayError extends Error {
  constructor(
    readonly code:
      | 'UNAVAILABLE'
      | 'INVALID_RESPONSE'
      | 'RATE_LIMITED'
      | 'CANCELLED'
      | 'NO_HISTORY'
      | 'CONFIGURATION_REQUIRED',
    readonly retryAfterSeconds?: number,
  ) {
    super(`MET_${code}`);
    this.name = 'MetNorwayError';
  }
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new MetNorwayError('INVALID_RESPONSE');
  return v as Record<string, unknown>;
}
function timestamp(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new MetNorwayError('INVALID_RESPONSE');
  // Compare components, so rollover dates do not silently become valid.
  if (new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19))
    throw new MetNorwayError('INVALID_RESPONSE');
  return v;
}
function scalar(
  details: Record<string, unknown>,
  units: Record<string, unknown>,
  key: string,
): WeatherValueDto {
  const u = units[key];
  const unit =
    typeof u === 'string' && u.length > 0 && u.length <= 32 ? u : null;
  if (!Object.hasOwn(details, key))
    return { state: 'missing', raw: null, unit, reason: 'not_provided' };
  const value = details[key];
  if (value === null)
    return { state: 'missing', raw: null, unit, reason: 'provider_null' };
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new MetNorwayError('INVALID_RESPONSE');
  const raw = String(value);
  if (unit === null)
    return { state: 'unknown', raw, unit, reason: 'unit_missing' };
  return { state: 'value', value: raw, raw, unit };
}
/** Stores only samples inside the requested local day; periods retain their full provider bounds. */
export function parseMetNorwayForecast(
  body: unknown,
  input: WeatherQueryDto,
  fetchedAt: string,
): WeatherReferenceDraftDto {
  try {
    const query = parseWeatherQuery(input, fetchedAt);
    if (query.product !== 'forecast') throw new MetNorwayError('NO_HISTORY');
    const response = object(body);
    if (response['type'] !== 'Feature')
      throw new MetNorwayError('INVALID_RESPONSE');
    const geometry = object(response['geometry']);
    const coords = geometry['coordinates'];
    if (
      geometry['type'] !== 'Point' ||
      !Array.isArray(coords) ||
      coords.length < 2 ||
      coords.length > 3 ||
      coords.some((c) => typeof c !== 'number' || !Number.isFinite(c))
    )
      throw new MetNorwayError('INVALID_RESPONSE');
    const expectedPoint = metForecastPoint(query.point);
    if (
      Math.abs(Number(coords[1]) - Number(expectedPoint.lat)) > 1e-8 ||
      Math.abs(Number(coords[0]) - Number(expectedPoint.lon)) > 1e-8
    )
      throw new MetNorwayError('INVALID_RESPONSE');
    const properties = object(response['properties']),
      meta = object(properties['meta']);
    const units = object(meta['units']),
      providerUpdatedAt = timestamp(meta['updated_at']);
    const series = properties['timeseries'];
    if (!Array.isArray(series) || series.length === 0 || series.length > 500)
      throw new MetNorwayError('INVALID_RESPONSE');
    const start = Date.parse(query.interval.startAt),
      end = Date.parse(query.interval.endAt);
    const instants: MetForecastDto['instants'] = [],
      periods: MetForecastDto['periods'] = [];
    let previous = -Infinity,
      coveredEnd = -Infinity;
    for (const entry of series) {
      const row = object(entry),
        at = timestamp(row['time']),
        ms = Date.parse(at);
      if (ms <= previous) throw new MetNorwayError('INVALID_RESPONSE');
      previous = ms;
      if (ms < start || ms >= end) continue;
      const data = object(row['data']),
        instant = object(data['instant']),
        details = object(instant['details']);
      instants.push({
        at,
        airTemperature: scalar(details, units, 'air_temperature'),
        windSpeed: scalar(details, units, 'wind_speed'),
        gust: scalar(details, units, 'wind_speed_of_gust'),
      });
      // An instant proves availability at that instant, not to the next sample.
      coveredEnd = Math.max(coveredEnd, ms + 1);
      for (const hours of [1, 6, 12] as const) {
        const key = `next_${hours}_hours`;
        if (!Object.hasOwn(data, key)) continue;
        const period = object(data[key]),
          summary = object(period['summary']),
          pd = object(period['details']);
        const symbol = summary['symbol_code'];
        if (
          symbol !== undefined &&
          symbol !== null &&
          (typeof symbol !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(symbol))
        )
          throw new MetNorwayError('INVALID_RESPONSE');
        const endAt = new Date(ms + hours * 3600000).toISOString();
        periods.push({
          startAt: at,
          endAt,
          hours,
          symbolCode: typeof symbol === 'string' ? symbol : null,
          precipitation: scalar(pd, units, 'precipitation_amount'),
        });
        coveredEnd = Math.max(coveredEnd, Math.min(end, Date.parse(endAt)));
      }
    }
    if (instants.length === 0) throw new MetNorwayError('NO_HISTORY');
    const notDaily: WeatherValueDto = {
      state: 'not_applicable',
      raw: null,
      unit: null,
      reason: 'met_period_products_not_daily_metrics',
    };
    return parseWeatherReferenceDraft({
      provider: 'met-norway',
      query,
      category: 'forecast',
      fetchedAt,
      publishedAt: null,
      coverage: 'partial',
      grid: null,
      metrics: Object.fromEntries(
        WEATHER_METRICS.map((k) => [k, { ...notDaily }]),
      ),
      forecast: {
        providerUpdatedAt,
        outboundPoint: metForecastPoint(query.point),
        returnedPoint: { lat: String(coords[1]), lon: String(coords[0]) },
        coveredInterval: {
          startAt: instants[0]?.at,
          endAt: new Date(coveredEnd).toISOString(),
        },
        instants,
        periods,
      },
    });
  } catch (e) {
    if (e instanceof MetNorwayError) throw e;
    throw new MetNorwayError('INVALID_RESPONSE');
  }
}

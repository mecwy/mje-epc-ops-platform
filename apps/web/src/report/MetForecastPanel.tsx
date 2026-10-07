import type { MetForecastDto, WeatherValueDto } from '@mje/contracts';
import { useI18n } from '../i18n.js';

const STATE_KEYS = {
  blank: 'weatherLocation_blank',
  missing: 'weatherLocation_missing',
  unknown: 'weatherLocation_unknown',
  not_applicable: 'weatherLocation_not_applicable',
} as const;

function ForecastValue({ value }: { value: WeatherValueDto }) {
  const { t } = useI18n();
  const stateKey =
    value.state === 'value' ? STATE_KEYS.unknown : STATE_KEYS[value.state];
  return value.state === 'value' ? (
    <>
      {value.value} {value.unit}
    </>
  ) : (
    <span aria-label={t(stateKey)}>
      {value.state === 'unknown' ? t('unknown') : '—'}
    </span>
  );
}

/** Read the provider's original UTC series; overlapping periods stay separate. */
export function MetForecastPanel({
  forecast,
  fetchedAt,
}: {
  forecast: MetForecastDto;
  fetchedAt: string;
}) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t('metForecast_title')}
      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <h3>{t('metForecast_title')}</h3>
      <p>
        {forecast.coveredInterval.startAt} — {forecast.coveredInterval.endAt} ·
        UTC
      </p>
      <dl>
        <div>
          <dt>{t('metForecast_updated')}</dt>
          <dd>{forecast.providerUpdatedAt}</dd>
        </div>
        <div>
          <dt>{t('weatherLocation_fetched')}</dt>
          <dd>{fetchedAt}</dd>
        </div>
      </dl>
      {forecast.instants.length > 0 && (
        <details>
          <summary>{t('metForecast_instants')}</summary>
          <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">UTC</th>
                  <th scope="col">{t('temperature')}</th>
                  <th scope="col">{t('metForecast_wind')}</th>
                  <th scope="col">{t('metForecast_gust')}</th>
                </tr>
              </thead>
              <tbody>
                {forecast.instants.map((instant) => (
                  <tr key={instant.at}>
                    <th scope="row">{instant.at}</th>
                    <td>
                      <ForecastValue value={instant.airTemperature} />
                    </td>
                    <td>
                      <ForecastValue value={instant.windSpeed} />
                    </td>
                    <td>
                      <ForecastValue value={instant.gust} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {forecast.periods.length > 0 && (
        <details>
          <summary>{t('metForecast_periods')}</summary>
          <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">UTC</th>
                  <th scope="col">{t('metForecast_hours')}</th>
                  <th scope="col">{t('metForecast_symbol')}</th>
                  <th scope="col">{t('metForecast_rain')}</th>
                </tr>
              </thead>
              <tbody>
                {forecast.periods.map((period) => (
                  <tr key={`${period.startAt}:${period.endAt}:${period.hours}`}>
                    <th scope="row">
                      {period.startAt} — {period.endAt}
                    </th>
                    <td>{period.hours} h</td>
                    <td>{period.symbolCode ?? '—'}</td>
                    <td>
                      <ForecastValue value={period.precipitation} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p className="muted small">
        <a
          href="https://api.met.no/weatherapi/locationforecast/2.0/documentation"
          target="_blank"
          rel="noopener noreferrer"
        >
          MET Norway
        </a>
        {' · '}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noopener noreferrer"
        >
          CC BY 4.0
        </a>
      </p>
    </section>
  );
}

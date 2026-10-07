import { useEffect, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n.js';
import type { WeatherLocationSession } from './weather-location-session.js';
import type { SafeFrozenWeatherReference } from '@mje/contracts';
import { weatherReferenceView } from './weather-adapter.js';
import { MetForecastPanel } from './MetForecastPanel.js';

const TEXT_KEYS = {
  title: 'weatherLocation_title',
  position: 'weatherLocation_position',
  cancel: 'weatherLocation_cancel',
  confirm: 'weatherLocation_confirm',
  fetching: 'weatherLocation_fetching',
  refresh: 'weatherLocation_refresh',
  reference: 'weatherLocation_reference',
  referenced: 'weatherLocation_referenced',
  idle: 'weatherLocation_idle',
  not_configured: 'weatherLocation_not_configured',
  unavailable: 'weatherLocation_unavailable',
  locating: 'weatherLocation_locating',
  denied: 'weatherLocation_denied',
  unsupported: 'weatherLocation_unsupported',
  locationUnavailable: 'weatherLocation_locationUnavailable',
  candidate: 'weatherLocation_candidate',
  confirmed_pending_save: 'weatherLocation_confirmed_pending_save',
  accuracy: 'weatherLocation_accuracy',
  device: 'weatherLocation_device',
  acquired: 'weatherLocation_acquired',
  unknown: 'weatherLocation_unknown',
  missing: 'weatherLocation_missing',
  blank: 'weatherLocation_blank',
  not_applicable: 'weatherLocation_not_applicable',
  reanalysis: 'weatherLocation_reanalysis',
  analysis: 'weatherLocation_analysis',
  forecast: 'weatherLocation_forecast',
  fetched: 'weatherLocation_fetched',
  published: 'weatherLocation_published',
  effective: 'weatherLocation_effective',
  partial: 'weatherLocation_partial',
  complete: 'weatherLocation_complete',
  stale: 'weatherLocation_stale',
  manual: 'weatherLocation_manual',
  temperature: 'weatherLocation_temperature',
  note: 'weatherLocation_note',
  positionNote: 'weatherLocation_positionNote',
  positionPrivacy: 'weatherLocation_positionPrivacy',
  positionPurpose: 'weatherLocation_positionPurpose',
  positionAccess: 'weatherLocation_positionAccess',
  positionRetention: 'weatherLocation_positionRetention',
  clear: 'weatherLocation_clear',
  detach: 'weatherLocation_detach',
  cleared: 'weatherLocation_cleared',
  savedLocation: 'weatherLocation_savedLocation',
  pending: 'weatherLocation_pending',
  retry: 'weatherLocation_retry',
  frozen: 'weatherLocation_frozen',
  adopted: 'weatherLocation_adopted',
  directory_loading: 'weatherLocation_directoryLoading',
  directory_none: 'weatherLocation_directoryNone',
  directory_choose: 'weatherLocation_directoryChoose',
  directory_failed: 'weatherLocation_directoryFailed',
  directory_updated: 'weatherLocation_directoryUpdated',
  select_scope: 'weatherLocation_selectScope',
  query_pending: 'weatherLocation_queryPending',
  query_unknown: 'weatherLocation_queryUnknown',
  continue: 'weatherLocation_continue',
  NO_HISTORY: 'weatherLocation_noHistory',
  UNAVAILABLE: 'weatherLocation_unavailable',
  RATE_LIMITED: 'weatherLocation_rateLimited',
  DISABLED: 'weatherLocation_disabled',
} as const;

export interface WeatherLocationProps {
  session: WeatherLocationSession;
  manualWeather?: string;
  manualTemperature?: string;
  onManualChange?: (field: 'weather' | 'temperature', value: string) => void;
  onClearLocation?: () => void;
  onDetachWeather?: () => void;
  savedLocation?: import('@mje/contracts').SafeReportLocationRef | null;
  pendingLocationKind?: 'capture' | 'clear' | null;
  pendingSave?: boolean;
  onRetrySave?: () => void;
  /** IDs from the parent's applied facts, distinct from the current weather query. */
  savedSnapshotIds?: readonly string[];
  weatherEnabled?: boolean;
  locationEnabled?: boolean;
}

/** Submitted and history views consume their frozen references, without current-provider reads. */
export function FrozenWeatherReferences({
  references,
}: {
  references: readonly SafeFrozenWeatherReference[];
}) {
  const { t } = useI18n();
  if (!references.length) return null;
  return (
    <section
      className="card"
      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
      aria-label={t('weatherLocation_frozen')}
    >
      <h2>{t('weatherLocation_frozen')}</h2>
      {references.map((reference) => {
        const view = weatherReferenceView(reference);
        const categoryKey = TEXT_KEYS[view.category];
        const coverageKey = TEXT_KEYS[view.coverage];
        return (
          <article key={reference.referenceId}>
            <strong>
              {t(categoryKey)} · {view.source}
            </strong>
            <p>
              {view.businessDate} · {view.timezone} · {t(coverageKey)}
            </p>
            {view.source === 'met-norway' ? (
              <MetForecastPanel
                forecast={view.forecast}
                fetchedAt={view.fetchedAt}
              />
            ) : (
              <dl>
                {view.values.map((value) => {
                  const stateKey =
                    value.state === 'value'
                      ? TEXT_KEYS.unknown
                      : TEXT_KEYS[value.state];
                  return (
                    <div key={value.label}>
                      <dt>{value.label}</dt>
                      <dd>
                        {value.state === 'value'
                          ? `${value.value} ${value.unit ?? ''}`
                          : t(stateKey)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
            <details>
              <summary>{t('weatherLocation_effective')}</summary>
              <p>
                {view.interval.startAt} — {view.interval.endAt}
              </p>
              <p>
                {t('weatherLocation_fetched')}: {view.fetchedAt}
              </p>
              {view.publishedAt && (
                <p>
                  {t('weatherLocation_published')}: {view.publishedAt}
                </p>
              )}
              <p>
                {t('weatherLocation_adopted')}: {reference.adoptedAt}
              </p>
              <p>
                {reference.adapterVersion} · {reference.responseHash}
              </p>
              <p>
                {reference.sourceLink} · {reference.licenseLink}
              </p>
            </details>
          </article>
        );
      })}
      <p>{t('weatherLocation_note')}</p>
    </section>
  );
}
/** Injected session: this component never calls navigator.geolocation or an external API. */
export function WeatherLocation({
  session,
  manualWeather,
  manualTemperature,
  onManualChange,
  onClearLocation,
  onDetachWeather,
  savedLocation,
  pendingLocationKind,
  pendingSave,
  onRetrySave,
  savedSnapshotIds = [],
  weatherEnabled = true,
  locationEnabled = true,
}: WeatherLocationProps) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const { t: sharedT } = useI18n();
  const t = Object.fromEntries(
    Object.entries(TEXT_KEYS).map(([key, message]) => [key, sharedT(message)]),
  ) as Record<keyof typeof TEXT_KEYS, string>;
  const context = state.context;
  const editable = state.writable && !state.locked;
  useEffect(() => {
    if (editable && weatherEnabled) void session.activateWeather();
    return () => session.deactivate();
  }, [session, editable, weatherEnabled]);
  const reference = state.reference;
  const alreadyReferenced =
    !!reference &&
    (state.referencedSnapshotId === reference.snapshotId ||
      savedSnapshotIds.includes(reference.snapshotId));
  const status = state.locationStatus;
  return (
    <section className="card report-weather" aria-label={t.title}>
      <h2>{t.title}</h2>
      <p>
        {context.businessDate} · {context.timezone}
      </p>
      {locationEnabled && (
        <>
          <p className="muted small">{t.positionNote}</p>
          <details>
            <summary>{t.positionPrivacy}</summary>
            <p>{t.positionPurpose}</p>
            <p>{t.positionAccess}</p>
            <p>{t.positionRetention}</p>
          </details>
          {state.writable && (
            <div>
              <button
                type="button"
                disabled={!editable || state.locating}
                onClick={() => void session.captureLocation()}
              >
                {t.position}
              </button>
              {(state.locating || state.candidate) && (
                <button type="button" onClick={session.cancelLocation}>
                  {t.cancel}
                </button>
              )}
            </div>
          )}
          <p role="status">
            {state.locating
              ? t.locating
              : status === 'unavailable'
                ? t.locationUnavailable
                : status === 'idle'
                  ? ''
                  : t[status]}
          </p>
          {state.candidate && state.writable && (
            <div>
              <p>
                {state.candidate.lat}, {state.candidate.lon} · {t.accuracy}:{' '}
                {state.candidate.accuracyM} m
              </p>
              <p>
                {t.device}: {state.candidate.deviceFixAt ?? t.unknown}
              </p>
              <p>
                {t.acquired}: {state.candidate.acquiredAt}
              </p>
              <button
                type="button"
                disabled={!editable}
                onClick={() => session.confirmLocation()}
              >
                {t.confirm}
              </button>
            </div>
          )}
          {savedLocation && (
            <p>
              {t.savedLocation} · {t.accuracy}: {savedLocation.accuracyM} m ·{' '}
              {t.device}: {savedLocation.deviceFixAt ?? t.unknown} ·{' '}
              {t.acquired}: {savedLocation.acquiredAt}
            </p>
          )}
          {pendingLocationKind && (
            <p>
              {pendingLocationKind === 'clear'
                ? t.cleared
                : t.confirmed_pending_save}
            </p>
          )}
          {pendingSave && (
            <p role="status">
              {t.pending}{' '}
              {onRetrySave && (
                <button type="button" onClick={onRetrySave}>
                  {t.retry}
                </button>
              )}
            </p>
          )}
          {state.writable && savedLocation && onClearLocation && (
            <button
              type="button"
              disabled={!editable}
              onClick={onClearLocation}
            >
              {t.clear}
            </button>
          )}
        </>
      )}
      {weatherEnabled && (
        <>
          {!locationEnabled && pendingSave && (
            <p role="status">
              {t.pending}{' '}
              {onRetrySave && (
                <button type="button" onClick={onRetrySave}>
                  {t.retry}
                </button>
              )}
            </p>
          )}
          {state.locationDirectoryStatus !== 'idle' && (
            <div>
              {state.locationDirectoryStatus !== 'selected' && (
                <p role="status">
                  {state.locationDirectoryStatus === 'loading'
                    ? t.directory_loading
                    : state.locationDirectoryStatus === 'none'
                      ? t.directory_none
                      : state.locationDirectoryStatus === 'choose'
                        ? t.directory_choose
                        : t.directory_failed}
                </p>
              )}
              {!!state.locations.length && (
                <label className="field">
                  <span>{t.select_scope}</span>
                  <select
                    value={context.locationVersionId ?? ''}
                    disabled={
                      !editable || state.locationDirectoryStatus === 'loading'
                    }
                    onChange={(event) =>
                      void session.selectWeatherLocation(event.target.value)
                    }
                  >
                    <option value="">{t.directory_choose}</option>
                    {state.locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.scopeKey} · v{location.n} ·{' '}
                        {location.confirmedAt}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {state.locationUpdated && (
                <p role="status">{t.directory_updated}</p>
              )}
            </div>
          )}
          {state.writable && onDetachWeather && (
            <button
              type="button"
              disabled={!editable}
              onClick={onDetachWeather}
            >
              {t.detach}
            </button>
          )}
          <div aria-live="polite">
            {state.weatherStatus === 'loading' ? (
              <p>{t.fetching}</p>
            ) : (
              state.weatherStatus !== 'ready' && (
                <p role="status">
                  {state.weatherStatus === 'pending'
                    ? t.query_pending
                    : state.weatherStatus === 'unknown'
                      ? t.query_unknown
                      : t[state.weatherStatus]}
                </p>
              )
            )}
            {reference && (
              <div>
                <strong>
                  {t[reference.category]} · {reference.source}
                </strong>
                <p>
                  {reference.businessDate} ·{' '}
                  {reference.coverage === 'partial' ? t.partial : t.complete}
                  {reference.stale ? ` · ${t.stale}` : ''}
                </p>
                {reference.source === 'met-norway' && reference.forecast ? (
                  <MetForecastPanel
                    forecast={reference.forecast}
                    fetchedAt={reference.fetchedAt}
                  />
                ) : (
                  <dl>
                    {reference.values.map((v, i) => (
                      <div key={`${v.label}:${i}`}>
                        <dt>{v.label}</dt>
                        <dd>
                          {v.state === 'value'
                            ? `${v.value ?? t.unknown} ${v.unit ?? ''}`
                            : t[v.state]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                <details>
                  <summary>{t.effective}</summary>
                  <p>
                    {reference.interval.startAt} — {reference.interval.endAt}
                  </p>
                  <p>
                    {t.fetched}: {reference.fetchedAt}
                  </p>
                  {reference.publishedAt && (
                    <p>
                      {t.published}: {reference.publishedAt}
                    </p>
                  )}
                </details>
                {state.writable && (
                  <button
                    type="button"
                    disabled={
                      !editable ||
                      state.weatherStatus !== 'ready' ||
                      alreadyReferenced ||
                      reference.stale
                    }
                    onClick={() => session.referenceWeather()}
                  >
                    {t.reference}
                  </button>
                )}
                {state.referencedSnapshotId && (
                  <p>
                    {t.referenced} · {state.referencedSnapshotId}
                  </p>
                )}
                {alreadyReferenced && !state.referencedSnapshotId && (
                  <p>{sharedT('saved')}</p>
                )}
              </div>
            )}
          </div>
          {state.writable && (
            <button
              type="button"
              disabled={
                !editable ||
                (!context.locationVersionId &&
                  !['none', 'choose', 'failed'].includes(
                    state.locationDirectoryStatus,
                  )) ||
                state.weatherStatus === 'loading'
              }
              onClick={() => void session.refreshWeather()}
            >
              {state.weatherStatus === 'pending' ||
              state.weatherStatus === 'unknown'
                ? t.continue
                : t.refresh}
            </button>
          )}
        </>
      )}
      <p className="muted small">{t.note}</p>
      {onManualChange && (
        <>
          <label className="field">
            <span>{t.manual}</span>
            <input
              value={manualWeather}
              disabled={!editable}
              maxLength={100}
              onChange={(e) => onManualChange('weather', e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t.temperature}</span>
            <input
              value={manualTemperature}
              disabled={!editable}
              maxLength={40}
              onChange={(e) => onManualChange('temperature', e.target.value)}
            />
          </label>
        </>
      )}
    </section>
  );
}

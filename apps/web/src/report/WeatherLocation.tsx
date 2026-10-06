import { useEffect, useSyncExternalStore } from 'react';
import type { WeatherLocationSession } from './weather-location-session.js';

const text = {
  zh: {
    title: '工地位置与天气参考',
    position: '本次定位（可选）',
    cancel: '放弃定位',
    confirm: '确认本次位置',
    fetching: '正在获取天气参考',
    refresh: '刷新参考',
    reference: '引用此参考',
    referenced: '参考已关联到草稿，待保存',
    idle: '尚未获取天气参考',
    not_configured: '尚未确认天气查询位置，可继续手填',
    unavailable: '天气参考暂不可用，可继续手填',
    locating: '正在获取一次位置',
    denied: '定位权限已拒绝，可继续手填',
    unsupported: '当前设备不支持定位，可继续手填',
    locationUnavailable: '未取得位置，可继续手填',
    candidate: '位置待确认',
    confirmed_pending_save: '本次位置已确认到草稿，待保存',
    accuracy: '精度半径',
    device: '设备采集时刻',
    acquired: '设备取得结果时刻',
    unknown: '未知',
    missing: '未提供',
    blank: '空白',
    not_applicable: '不适用',
    reanalysis: '历史再分析参考',
    analysis: '历史模型分析参考',
    forecast: '预报参考',
    fetched: '查询时间',
    published: '发布时间',
    effective: '适用时段',
    partial: '部分指标缺失',
    complete: '请求指标已返回',
    stale: '已过期',
    manual: '现场天气观察',
    temperature: '现场温度',
    note: '天气参考不证明现场实测、停工或安全放行。',
    positionNote: '记录本次填报位置；补录时不能作为过去日期的位置。',
  },
  en: {
    title: 'Site location and weather reference',
    position: 'Locate once (optional)',
    cancel: 'Discard location',
    confirm: 'Confirm this location',
    fetching: 'Loading weather reference',
    refresh: 'Refresh reference',
    reference: 'Reference this snapshot',
    referenced: 'Reference added to draft; awaiting save',
    idle: 'Weather reference not requested',
    not_configured:
      'Weather location not confirmed; manual entry remains available',
    unavailable:
      'Weather reference unavailable; manual entry remains available',
    locating: 'Obtaining one location',
    denied: 'Location permission denied; manual entry remains available',
    unsupported: 'Location unsupported; manual entry remains available',
    locationUnavailable: 'No location obtained; manual entry remains available',
    candidate: 'Location awaiting confirmation',
    confirmed_pending_save: 'Location confirmed in draft; awaiting save',
    accuracy: 'Accuracy radius',
    device: 'Device fix time',
    acquired: 'Device result acquisition time',
    unknown: 'Unknown',
    missing: 'Not provided',
    blank: 'Blank',
    not_applicable: 'Not applicable',
    reanalysis: 'Historical reanalysis reference',
    analysis: 'Historical model analysis reference',
    forecast: 'Forecast reference',
    fetched: 'Fetched at',
    published: 'Published at',
    effective: 'Effective interval',
    partial: 'Some metrics unavailable',
    complete: 'Requested metrics returned',
    stale: 'Expired',
    manual: 'Onsite weather observation',
    temperature: 'Onsite temperature',
    note: 'Weather reference does not verify onsite conditions, downtime or work permission.',
    positionNote:
      'This is the reporting location now; it cannot establish a past-day location.',
  },
} as const;

export interface WeatherLocationProps {
  session: WeatherLocationSession;
  locale: 'zh' | 'en';
  manualWeather: string;
  manualTemperature: string;
  onManualChange: (field: 'weather' | 'temperature', value: string) => void;
}
/** Injected session: this component never calls navigator.geolocation or an external API. */
export function WeatherLocation({
  session,
  locale,
  manualWeather,
  manualTemperature,
  onManualChange,
}: WeatherLocationProps) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const t = text[locale];
  const context = state.context;
  const editable = state.writable && !state.locked;
  useEffect(() => {
    if (editable) void session.refreshWeather();
    return () => session.deactivate();
  }, [
    session,
    context.ownerKey,
    context.projectId,
    context.businessDate,
    context.timezone,
    context.locationVersionId,
    editable,
  ]);
  const reference = state.reference;
  const status = state.locationStatus;
  return (
    <section className="card report-weather" aria-label={t.title}>
      <h2>{t.title}</h2>
      <p>
        {context.businessDate} · {context.timezone} ·{' '}
        {context.locationVersionId ?? t.not_configured}
      </p>
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
      <p className="muted small">{t.positionNote}</p>
      <div aria-live="polite">
        {state.weatherStatus === 'loading' ? (
          <p>{t.fetching}</p>
        ) : (
          state.weatherStatus !== 'ready' && <p>{t[state.weatherStatus]}</p>
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
            <details>
              <summary>{t.effective}</summary>
              <p>
                {reference.interval.startAt} — {reference.interval.endAt}
              </p>
              <p>
                {t.fetched}: {reference.fetchedAt}
              </p>
              <p>
                {t.published}: {reference.publishedAt ?? t.unknown}
              </p>
            </details>
            {state.writable && (
              <button
                type="button"
                disabled={
                  !editable ||
                  state.weatherStatus !== 'ready' ||
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
          </div>
        )}
      </div>
      {state.writable && (
        <button
          type="button"
          disabled={
            !editable ||
            !context.locationVersionId ||
            state.weatherStatus === 'loading'
          }
          onClick={() => void session.refreshWeather()}
        >
          {t.refresh}
        </button>
      )}
      <p className="muted small">{t.note}</p>
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
    </section>
  );
}

import { useEffect, useReducer, useState } from 'react';
import {
  PM_PROXY_DAYS_MAX,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  type FieldSettingsDto,
} from '@mje/contracts';
import type { Project, ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import { FieldSession } from '../field/session.js';
import { locate } from '../report/geo.js';
import {
  checkProxyDays,
  checkSite,
  type SiteField,
  type SiteProblem,
} from './site-form.js';

type Settings = FieldSession<FieldSettingsDto>;

/** A numbered settings read (C24); each card keeps its own, so their commands never mix. */
function useSettings(api: ReportApi, projectId: string): Settings {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [session] = useState(
    () =>
      new FieldSession<FieldSettingsDto>(
        () => api.fieldSettings(projectId),
        rerender,
      ),
  );
  useEffect(() => void session.load(), [session]);
  return session;
}
function Loading({ session }: { session: Settings }) {
  const { t } = useI18n();
  return (
    <section className="card noprint">
      {session.readError ? (
        <div className="banner err" role="alert">
          <ErrorText code={session.readError} />
        </div>
      ) : (
        <p className="muted">{t('loading')}</p>
      )}
    </section>
  );
}
/** Field settings and the site location; PM only. */
export function SettingsCards({
  api,
  project,
}: {
  api: ReportApi;
  project: Project;
}) {
  const site = useSettings(api, project.id);
  const settings = useSettings(api, project.id);
  return (
    <>
      {site.data ? (
        <SiteLocationCard
          key={`site-${site.data.siteReference?.n ?? 0}`}
          api={api}
          project={project}
          session={site}
          data={site.data}
        />
      ) : (
        <Loading session={site} />
      )}
      {settings.data ? (
        <FieldSettingsCard
          key={`settings-${settings.data.settings.n}`}
          api={api}
          project={project}
          session={settings}
          data={settings.data}
        />
      ) : (
        <Loading session={settings} />
      )}
    </>
  );
}

function Problem({
  field,
  problem,
}: {
  field: SiteField;
  problem?: SiteProblem | undefined;
}) {
  const { t } = useI18n();
  if (!problem) return null;
  const key =
    problem === 'required'
      ? 'pm_errRequired'
      : problem === 'decimals'
        ? 'pm_errDecimals'
        : problem === 'range' && field === 'radius'
          ? 'pm_errRadius'
          : problem === 'range'
            ? 'pm_errRange'
            : 'pm_errFormat';
  return (
    <span className="warn-t small" role="alert">
      {t(key, { min: RADIUS_MIN_M, max: RADIUS_MAX_M })}
    </span>
  );
}

/**
 * The site location (工地位置, design §3, U2): coordinates typed or taken from this device,
 * and a radius of 50–2000 m. Coordinates are shown to the PM only and never logged. A new
 * reference applies to later check-ins; submitted days keep what they froze.
 */
function SiteLocationCard({
  api,
  project,
  session,
  data,
}: {
  api: ReportApi;
  project: Project;
  session: Settings;
  data: FieldSettingsDto;
}) {
  const { t } = useI18n();
  const ref = data.siteReference;
  const [lat, setLat] = useState(ref?.lat ?? '');
  const [lon, setLon] = useState(ref?.lon ?? '');
  const [radius, setRadius] = useState(String(ref?.radiusM ?? 500));
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const check = checkSite({ lat, lon, radius });
  const problems = check.ok ? {} : check.problems;
  const takeHere = async () => {
    setLocating(true);
    setNote(null);
    const r = await locate(navigator.geolocation);
    setLocating(false);
    if (!r.fix) {
      const key =
        r.reason === 'denied'
          ? 'locDenied'
          : r.reason === 'unsupported'
            ? 'locUnsupported'
            : 'locNoFix';
      setNote(t(key));
      return;
    }
    setLat(r.fix.lat);
    setLon(r.fix.lon);
    setNote(t('located', { m: Math.round(Number(r.fix.accuracyM)) }));
  };
  const save = async () => {
    setTried(true);
    setError(null);
    if (!check.ok && !session.pending) return;
    const r = session.pending
      ? await session.retry()
      : await session.act((d) => {
          if (!d || !check.ok) return null;
          const c = {
            projectId: project.id,
            clientMutationId: crypto.randomUUID(),
            expectedN: d.siteReference?.n ?? 0,
            lat: check.lat,
            lon: check.lon,
            radiusM: check.radiusM,
          };
          return {
            key: c.clientMutationId,
            send: () => api.setSiteReference(c),
          };
        });
    if (r.kind !== 'ok') setError(r.code);
  };
  return (
    <section className="card noprint">
      <h2 className="blk">{t('pm_siteTitle')}</h2>
      {ref ? (
        <p className="muted small">
          {t('pm_siteCurrent', { r: ref.radiusM })}{' '}
          <span className="num">
            {ref.lat}, {ref.lon}
          </span>
        </p>
      ) : (
        <div className="banner warn">{t('pm_siteMissing')}</div>
      )}
      <div className="row2 wrap2">
        <label className="field">
          <span>{t('pm_lat')}</span>
          <input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            value={lat}
            aria-invalid={Boolean(tried && problems.lat) || undefined}
            onChange={(e) => setLat(e.target.value)}
          />
          {tried && <Problem field="lat" problem={problems.lat} />}
        </label>
        <label className="field">
          <span>{t('pm_lon')}</span>
          <input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            value={lon}
            aria-invalid={Boolean(tried && problems.lon) || undefined}
            onChange={(e) => setLon(e.target.value)}
          />
          {tried && <Problem field="lon" problem={problems.lon} />}
        </label>
      </div>
      <button
        type="button"
        className="ghost"
        disabled={locating}
        onClick={() => void takeHere()}
      >
        {locating ? t('locating') : t('pm_useHere')}
      </button>
      {note && <p className="muted small">{note}</p>}
      <label className="field">
        <span>{t('pm_radius', { min: RADIUS_MIN_M, max: RADIUS_MAX_M })}</span>
        <input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={radius}
          aria-invalid={Boolean(tried && problems.radius) || undefined}
          onChange={(e) => setRadius(e.target.value)}
        />
        {tried && <Problem field="radius" problem={problems.radius} />}
      </label>
      <p className="muted small">{t('pm_siteNote')}</p>
      {error && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      <button
        type="button"
        className="primary"
        disabled={session.busy}
        onClick={() => void save()}
      >
        {session.pending ? t('retry') : t('save')}
      </button>
    </section>
  );
}

/** U1 selfie switch (off by default; only after HR/legal confirm) and the PM proxy window. */
function FieldSettingsCard({
  api,
  project,
  session,
  data,
}: {
  api: ReportApi;
  project: Project;
  session: Settings;
  data: FieldSettingsDto;
}) {
  const { t } = useI18n();
  const [selfie, setSelfie] = useState(data.settings.selfieEnabled);
  const [days, setDays] = useState(String(data.settings.pmProxyDays));
  const [error, setError] = useState<string | null>(null);
  const parsedDays = checkProxyDays(days);
  const changed =
    selfie !== data.settings.selfieEnabled ||
    parsedDays !== data.settings.pmProxyDays;
  const save = async () => {
    setError(null);
    const r = session.pending
      ? await session.retry()
      : await session.act((d) => {
          if (!d || parsedDays === null) return null;
          const c = {
            projectId: project.id,
            clientMutationId: crypto.randomUUID(),
            expectedN: d.settings.n,
            selfieEnabled: selfie,
            pmProxyDays: parsedDays,
          };
          return {
            key: c.clientMutationId,
            send: () => api.setFieldSettings(c),
          };
        });
    if (r.kind !== 'ok') setError(r.code);
  };
  return (
    <section className="card noprint">
      <h2 className="blk">{t('pm_settingsTitle')}</h2>
      <div className="blk-row">
        <span className="grow">
          <b>{t('pm_selfie')}</b>
          <span className="muted small">{t('pm_selfieNote')}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={selfie}
          className={`switch${selfie ? ' on' : ''}`}
          onClick={() => setSelfie(!selfie)}
        >
          {selfie ? t('pm_on') : t('pm_off')}
        </button>
      </div>
      <label className="field">
        <span>{t('pm_proxyDays', { max: PM_PROXY_DAYS_MAX })}</span>
        <input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={days}
          aria-invalid={parsedDays === null || undefined}
          onChange={(e) => setDays(e.target.value)}
        />
        {parsedDays === null && (
          <span className="warn-t small" role="alert">
            {t('pm_errDays', { max: PM_PROXY_DAYS_MAX })}
          </span>
        )}
      </label>
      {error && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      <button
        type="button"
        className="primary"
        disabled={
          session.busy ||
          (!session.pending && (!changed || parsedDays === null))
        }
        onClick={() => void save()}
      >
        {session.pending ? t('retry') : t('save')}
      </button>
    </section>
  );
}

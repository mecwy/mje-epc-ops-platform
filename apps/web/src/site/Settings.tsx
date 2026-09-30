import { useEffect, useState } from 'react';
import {
  PM_PROXY_DAYS_MAX,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  type FieldSettingsDto,
} from '@mje/contracts';
import type { Project, ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import type { OwnedCommands } from '../field/owned-commands.js';
import type { FieldSession } from '../field/session.js';
import { locate } from '../report/geo.js';
import {
  checkProxyDays,
  checkSite,
  type SiteField,
  type SiteProblem,
} from './site-form.js';
import {
  saveSettings,
  saveSiteReference,
  type FormSave,
  type SettingsValue,
  type SiteSessions,
  type SiteValue,
} from './site-sessions.js';
import { useSessions } from './use-sessions.js';

type Settings = FieldSession<FieldSettingsDto>;

/** A save whose answer was lost: the form shows its values, locked, until Retry or Give up. */
function UnsavedBanner({ code }: { code: string | null }) {
  const { t } = useI18n();
  return (
    <div className="banner warn" role="alert">
      {t('pm_saveUnresolved')} <ErrorText code={code ?? 'NETWORK'} />
    </div>
  );
}
function SaveButtons({
  pending,
  busy,
  onSave,
  onGiveUp,
}: {
  pending: boolean;
  busy: boolean;
  onSave: () => void;
  onGiveUp: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="row2">
      {pending && (
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={onGiveUp}
        >
          {t('pm_giveUp')}
        </button>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={onSave}
      >
        {pending ? t('retry') : t('save')}
      </button>
    </div>
  );
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
/** Field settings and the site location; PM only. Sessions live with the workspace. */
export function SettingsCards({
  api,
  project,
  sessions,
}: {
  api: ReportApi;
  project: Project;
  sessions: SiteSessions;
}) {
  useSessions(sessions);
  const site = sessions.site;
  const settings = sessions.settings;
  useEffect(() => {
    void site.load();
    void settings.load();
  }, [site, settings]);
  return (
    <>
      {site.data ? (
        <SiteLocationCard
          key={`site-${site.data.siteReference?.n ?? 0}`}
          api={api}
          project={project}
          session={site}
          commands={sessions.siteSave}
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
          commands={sessions.settingsSave}
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
  commands,
  data,
}: {
  api: ReportApi;
  project: Project;
  session: Settings;
  commands: OwnedCommands<FieldSettingsDto, FormSave<SiteValue>>;
  data: FieldSettingsDto;
}) {
  const { t } = useI18n();
  const ref = data.siteReference;
  // An unresolved save is shown as sent (locked): what is on screen is what Retry sends.
  const pending = commands.unresolved?.value ?? null;
  const sent = commands.current?.value ?? null;
  const [lat, setLat] = useState(sent?.lat ?? ref?.lat ?? '');
  const [lon, setLon] = useState(sent?.lon ?? ref?.lon ?? '');
  const [radius, setRadius] = useState(
    String(sent?.radiusM ?? ref?.radiusM ?? 500),
  );
  const locked = commands.owned;
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
    if (!check.ok && !pending) return;
    const r = pending
      ? await commands.retry()
      : check.ok
        ? await saveSiteReference(commands, api, project.id, data, {
            lat: check.lat,
            lon: check.lon,
            radiusM: check.radiusM,
          })
        : null;
    if (!r) return;
    if (r.kind !== 'ok') setError(r.code);
  };
  const giveUp = () => {
    commands.discard();
    setError(null);
    setLat(ref?.lat ?? '');
    setLon(ref?.lon ?? '');
    setRadius(String(ref?.radiusM ?? 500));
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
            readOnly={locked}
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
            readOnly={locked}
            aria-invalid={Boolean(tried && problems.lon) || undefined}
            onChange={(e) => setLon(e.target.value)}
          />
          {tried && <Problem field="lon" problem={problems.lon} />}
        </label>
      </div>
      <button
        type="button"
        className="ghost"
        disabled={locating || locked}
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
          readOnly={locked}
          aria-invalid={Boolean(tried && problems.radius) || undefined}
          onChange={(e) => setRadius(e.target.value)}
        />
        {tried && <Problem field="radius" problem={problems.radius} />}
      </label>
      <p className="muted small">{t('pm_siteNote')}</p>
      {pending && <UnsavedBanner code={error ?? session.error} />}
      {error && !pending && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      <SaveButtons
        pending={pending !== null}
        busy={session.busy || (commands.owned && !pending)}
        onSave={() => void save()}
        onGiveUp={giveUp}
      />
    </section>
  );
}

/** U1 selfie switch (off by default; only after HR/legal confirm) and the PM proxy window. */
function FieldSettingsCard({
  api,
  project,
  session,
  commands,
  data,
}: {
  api: ReportApi;
  project: Project;
  session: Settings;
  commands: OwnedCommands<FieldSettingsDto, FormSave<SettingsValue>>;
  data: FieldSettingsDto;
}) {
  const { t } = useI18n();
  const pending = commands.unresolved?.value ?? null;
  const sent = commands.current?.value ?? null;
  const [selfie, setSelfie] = useState(
    sent?.selfieEnabled ?? data.settings.selfieEnabled,
  );
  const [days, setDays] = useState(
    String(sent?.pmProxyDays ?? data.settings.pmProxyDays),
  );
  const locked = commands.owned;
  const [error, setError] = useState<string | null>(null);
  const parsedDays = checkProxyDays(days);
  const changed =
    selfie !== data.settings.selfieEnabled ||
    parsedDays !== data.settings.pmProxyDays;
  const save = async () => {
    setError(null);
    const r = pending
      ? await commands.retry()
      : parsedDays !== null
        ? await saveSettings(commands, api, project.id, data, {
            selfieEnabled: selfie,
            pmProxyDays: parsedDays,
          })
        : null;
    if (!r) return;
    if (r.kind !== 'ok') setError(r.code);
  };
  const giveUp = () => {
    commands.discard();
    setError(null);
    setSelfie(data.settings.selfieEnabled);
    setDays(String(data.settings.pmProxyDays));
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
          disabled={locked}
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
          readOnly={locked}
          aria-invalid={parsedDays === null || undefined}
          onChange={(e) => setDays(e.target.value)}
        />
        {parsedDays === null && (
          <span className="warn-t small" role="alert">
            {t('pm_errDays', { max: PM_PROXY_DAYS_MAX })}
          </span>
        )}
      </label>
      {pending && <UnsavedBanner code={error ?? session.error} />}
      {error && !pending && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      <SaveButtons
        pending={pending !== null}
        busy={
          session.busy ||
          (commands.owned && !pending) ||
          (!pending && (!changed || parsedDays === null))
        }
        onSave={() => void save()}
        onGiveUp={giveUp}
      />
    </section>
  );
}

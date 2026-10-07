import { useEffect, useRef, useState } from 'react';
import {
  PM_PROXY_DAYS_MAX,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  type FieldSettingsDto,
} from '@mje/contracts';
import type { Project, ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { Sheet } from '../ui.js';
import { ErrorText } from '../field/ErrorText.js';
import type { OwnedCommands } from '../field/owned-commands.js';
import type { FieldSession } from '../field/session.js';
import { acquirePosition, toFix } from '../report/geo.js';
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

/**
 * An owned save (running or unresolved), shown as its payload only: no inputs are mounted, so
 * nothing on screen can differ from what Retry sends. Retry resends the same payload and key;
 * Give up drops it and editing restarts from the latest read.
 */
function OwnedSave({
  title,
  rows,
  commands,
}: {
  title: string;
  rows: [string, string][];
  commands: OwnedCommands<FieldSettingsDto, FormSave<unknown>>;
}) {
  const { t } = useI18n();
  const busy = commands.session.busy;
  const unresolved = commands.unresolved !== null;
  return (
    <section className="card noprint">
      <h2 className="blk">{title}</h2>
      {rows.map(([k, v]) => (
        <div className="kv" key={k}>
          <span>{k}</span>
          <span className="num">{v}</span>
        </div>
      ))}
      {unresolved ? (
        <div className="banner warn" role="alert">
          {t('pm_saveUnresolved')}{' '}
          <ErrorText code={commands.session.error ?? 'NETWORK'} write />
        </div>
      ) : (
        <p className="muted small">{t('saving')}</p>
      )}
      {unresolved && (
        <div className="row2">
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => commands.discard()}
          >
            {t('pm_giveUp')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void commands.retry()}
          >
            {t('retry')}
          </button>
        </div>
      )}
    </section>
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
  const { t } = useI18n();
  useSessions(sessions);
  const site = sessions.site;
  const settings = sessions.settings;
  useEffect(() => {
    void site.load();
    void settings.load();
  }, [site, settings]);
  const settingsSave = sessions.settingsSave.current;
  return (
    <>
      <SiteLocationSummary
        key={`site-location:${project.id}`}
        api={api}
        project={project}
        sessions={sessions}
      />
      {settingsSave ? (
        <OwnedSave
          title={t('pm_settingsTitle')}
          commands={sessions.settingsSave}
          rows={[
            [
              t('pm_selfie'),
              settingsSave.value.selfieEnabled ? t('pm_on') : t('pm_off'),
            ],
            [
              t('pm_proxyDays', { max: PM_PROXY_DAYS_MAX }),
              String(settingsSave.value.pmProxyDays),
            ],
          ]}
        />
      ) : settings.data ? (
        <FieldSettingsCard
          key={`field-settings:${project.id}:${settings.data.settings.n}:${sessions.settingsSave.generation}`}
          api={api}
          project={project}
          commands={sessions.settingsSave}
          data={settings.data}
        />
      ) : (
        <Loading session={settings} />
      )}
    </>
  );
}

/** One stable summary identity: never share the settings card's revision/generation key. */
function SiteLocationSummary({
  api,
  project,
  sessions,
}: {
  api: ReportApi;
  project: Project;
  sessions: SiteSessions;
}) {
  const { t } = useI18n();
  const session = sessions.site,
    commands = sessions.siteSave;
  const data = session.data,
    ref = data?.siteReference;
  const owner = commands.current;
  // Opening freezes this read. Later background reads never rebind an editor's expectedN.
  const [editing, setEditing] = useState<{
    data: FieldSettingsDto;
    generation: number;
  } | null>(null);
  const [showOwned, setShowOwned] = useState(false);
  const openEditor =
    editing !== null && editing.generation === commands.generation;
  const isOpen = owner ? showOwned : openEditor;
  const [verifiedRead, setVerifiedRead] = useState<{
    data: FieldSettingsDto | null;
    generation: number;
  } | null>(null);
  const stale =
    session.readError !== null ||
    (session.error === 'STALE' &&
      !(
        verifiedRead?.data === data &&
        verifiedRead?.generation === commands.generation
      ));
  const reload = async () => {
    if (await session.load())
      setVerifiedRead({ data: session.data, generation: commands.generation });
  };
  const rows: [string, string][] = owner
    ? [
        [t('pm_lat'), owner.value.lat],
        [t('pm_lon'), owner.value.lon],
        [
          t('pm_radius', { min: RADIUS_MIN_M, max: RADIUS_MAX_M }),
          String(owner.value.radiusM),
        ],
      ]
    : [];
  const open = () => {
    setShowOwned(true);
    if (!owner && data) setEditing({ data, generation: commands.generation });
  };
  const close = () => {
    setEditing(null);
    setShowOwned(false);
  };
  return (
    <section className="card noprint" data-site-location-summary>
      <div className="blk-row">
        <h2 className="blk">{t('pm_siteTitle')}</h2>
        <button
          type="button"
          className="ghost"
          onClick={open}
          disabled={!owner && (!data || !commands.canStart)}
        >
          {owner
            ? t('pm_siteReviewSave')
            : ref
              ? t('pm_siteEdit')
              : t('pm_siteAdd')}
        </button>
      </div>
      {owner ? (
        <>
          <p className="muted small" role="status">
            {commands.unresolved ? t('pm_siteSavePending') : t('saving')}
          </p>
          {rows.map(([label, value]) => (
            <div className="kv" key={label}>
              <span>{label}</span>
              <span className="num">{value}</span>
            </div>
          ))}
        </>
      ) : data ? (
        <>
          {stale && <p className="muted small">{t('pm_siteLastConfirmed')}</p>}
          {ref ? (
            stale ? (
              <div className="kv">
                <span className="num">
                  {ref.lat}, {ref.lon}
                </span>
                <span>
                  {t('pm_radius', { min: RADIUS_MIN_M, max: RADIUS_MAX_M })}:{' '}
                  {ref.radiusM}
                </span>
              </div>
            ) : (
              <p className="muted small">
                {t('pm_siteCurrent', { r: ref.radiusM })}{' '}
                <span className="num">
                  {ref.lat}, {ref.lon}
                </span>
              </p>
            )
          ) : stale ? (
            <p className="muted small">{t('noSite')}</p>
          ) : (
            <div className="banner warn">{t('pm_siteMissing')}</div>
          )}
          <Refusal
            code={commands.refusal}
            uncertain={commands.refusalUncertain}
          />
        </>
      ) : !session.readError ? (
        <p className="muted">{t('loading')}</p>
      ) : null}
      {!owner && stale && (
        <div className="banner err" role="alert">
          <ErrorText code={session.readError ?? 'STALE'} />
        </div>
      )}
      {!owner && (stale || !data) && (
        <button type="button" className="ghost" onClick={() => void reload()}>
          {t('pm_reload')}
        </button>
      )}
      {isOpen && (
        <Sheet
          key={owner ? 'site-pending' : 'site-edit'}
          title={
            owner
              ? t('pm_siteReviewSave')
              : editing!.data.siteReference
                ? t('pm_siteEdit')
                : t('pm_siteAdd')
          }
          onClose={close}
        >
          <p className="muted small">{t('pm_siteSingleLimit')}</p>
          {owner ? (
            <OwnedSave
              title={t('pm_siteSavePending')}
              rows={rows}
              commands={commands}
            />
          ) : (
            <SiteLocationEditor
              api={api}
              project={project}
              commands={commands}
              data={editing!.data}
              onClose={close}
            />
          )}
        </Sheet>
      )}
    </section>
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
/** The last definite refusal of this form's save, shown after editing restarted. */
function Refusal({
  code,
  uncertain,
}: {
  code: string | null;
  uncertain: boolean;
}) {
  if (!code) return null;
  return (
    <div className="banner err" role="alert">
      <ErrorText code={code} write uncertain={uncertain} />
    </div>
  );
}

/**
 * The site location (工地位置, design §3, U2): coordinates typed or taken from this device,
 * and a radius of 50–2000 m, edited from `data` (the read this form mounted with; its number
 * is the save's expectedN). Coordinates are shown to the PM only and never logged. A new
 * reference applies to later check-ins; submitted days keep what they froze.
 */
function SiteLocationEditor({
  api,
  project,
  commands,
  data,
  onClose,
}: {
  api: ReportApi;
  project: Project;
  onClose: () => void;
  commands: OwnedCommands<FieldSettingsDto, FormSave<SiteValue>>;
  data: FieldSettingsDto;
}) {
  const { t } = useI18n();
  const ref = data.siteReference;
  const [lat, setLat] = useState(ref?.lat ?? '');
  const [lon, setLon] = useState(ref?.lon ?? '');
  const [radius, setRadius] = useState(String(ref?.radiusM ?? 500));
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const fixTicket = useRef(0);
  const geoAbort = useRef<AbortController | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (locating) cancelButton.current?.focus();
  }, [locating]);
  useEffect(
    () => () => {
      fixTicket.current++;
      geoAbort.current?.abort();
    },
    [],
  );
  const check = checkSite({ lat, lon, radius });
  const problems = check.ok ? {} : check.problems;
  const takeHere = async () => {
    const ticket = ++fixTicket.current;
    setLocating(true);
    setNote(null);
    const controller = new AbortController();
    geoAbort.current = controller;
    const r = await acquirePosition(
      navigator.geolocation,
      (reading, now) => toFix(reading.coords, reading.timestamp, now),
      undefined,
      controller.signal,
    );
    if (ticket !== fixTicket.current || commands.owned) return;
    setLocating(false);
    // Closed/replaced editors and owned saves cannot adopt a late device fix.
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
    if (!check.ok || locating) return;
    await saveSiteReference(commands, api, project.id, data, {
      lat: check.lat,
      lon: check.lon,
      radiusM: check.radiusM,
    });
  };
  return (
    <div data-site-location-editor>
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
        disabled={locating || !commands.canStart}
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
      <Refusal code={commands.refusal} uncertain={commands.refusalUncertain} />
      <div className="row2">
        <button
          ref={cancelButton}
          type="button"
          className="ghost"
          onClick={onClose}
        >
          {t('close')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={locating || !commands.canStart}
          onClick={() => void save()}
        >
          {t('save')}
        </button>
      </div>
    </div>
  );
}

/**
 * U1 selfie switch (off by default; only after HR/legal confirm) and the PM proxy window,
 * edited from `data` (its number is the save's expectedN).
 */
function FieldSettingsCard({
  api,
  project,
  commands,
  data,
}: {
  api: ReportApi;
  project: Project;
  commands: OwnedCommands<FieldSettingsDto, FormSave<SettingsValue>>;
  data: FieldSettingsDto;
}) {
  const { t } = useI18n();
  const [selfie, setSelfie] = useState(data.settings.selfieEnabled);
  const [days, setDays] = useState(String(data.settings.pmProxyDays));
  const parsedDays = checkProxyDays(days);
  const changed =
    selfie !== data.settings.selfieEnabled ||
    parsedDays !== data.settings.pmProxyDays;
  const save = async () => {
    if (parsedDays === null) return;
    await saveSettings(commands, api, project.id, data, {
      selfieEnabled: selfie,
      pmProxyDays: parsedDays,
    });
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
      <Refusal code={commands.refusal} uncertain={commands.refusalUncertain} />
      <button
        type="button"
        className="primary"
        disabled={!commands.canStart || !changed || parsedDays === null}
        onClick={() => void save()}
      >
        {t('save')}
      </button>
    </section>
  );
}

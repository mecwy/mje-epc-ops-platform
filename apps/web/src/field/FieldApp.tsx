import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { EntryDto, FieldMeDto } from '@mje/contracts';
import { LANGS, isLang } from '@mje/ui';
import { ApiError } from '../api.js';
import { I18nProvider, useI18n } from '../i18n.js';
import { Sheet } from '../ui.js';
import { fmtDay, siteToday } from '../report/format.js';
import { DeviceStore, newToken, type DeviceRecord } from './device-store.js';
import { ErrorText } from './ErrorText.js';
import { deviceApi, type DeviceApi } from './field-api.js';
import {
  canRelease,
  codeFromHash,
  deviceView,
  startScreen,
  type FieldScreen,
  type Result,
} from './flow.js';
import { ENDED, FieldSession } from './session.js';
import { releaseDevice } from './release.js';
import { CheckInCard } from './CheckInCard.js';
import { CrewCard, ReportCard } from './ForemanPanel.js';

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}
const CODE_KEY = 'mje-field-entry';
/**
 * The entry code from the scanned link, kept for this tab only (to register again without
 * rescanning) and removed from the address bar so it is not left in history or screenshots.
 */
function takeEntryCode(): string | null {
  const fromHash = codeFromHash(window.location.hash);
  const tab = storage('session');
  if (fromHash) {
    try {
      tab?.setItem(CODE_KEY, fromHash);
    } catch {
      /* this visit only */
    }
    history.replaceState(null, '', window.location.pathname);
    return fromHash;
  }
  try {
    return codeFromHash(`#e=${tab?.getItem(CODE_KEY) ?? ''}`);
  } catch {
    return null;
  }
}
async function result<T>(p: Promise<T>): Promise<Result<T>> {
  try {
    return { ok: await p };
  } catch (e) {
    return { error: e instanceof ApiError ? e.code : 'REQUEST_FAILED' };
  }
}

function LangSelect() {
  const { t, lang, setLang } = useI18n();
  return (
    <select
      className="lang"
      aria-label={t('language')}
      value={lang}
      onChange={(e) => isLang(e.target.value) && setLang(e.target.value)}
    >
      {Object.entries(LANGS).map(([k, name]) => (
        <option key={k} value={k}>
          {name}
        </option>
      ))}
    </select>
  );
}
function Bar({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="bar">
      <div className="bar-title">
        {sub && <span className="bar-sub">{sub}</span>}
        <span className="bar-h">{title}</span>
      </div>
      <LangSelect />
    </header>
  );
}

function FieldRoot() {
  const { t } = useI18n();
  const [store] = useState(() => new DeviceStore(storage('local')));
  const [code] = useState(takeEntryCode);
  const [screen, setScreen] = useState<FieldScreen>({ kind: 'loading' });
  const start = useCallback(async () => {
    setScreen({ kind: 'loading' });
    const entry = code ? await result(deviceApi(() => null).entry(code)) : null;
    setScreen(startScreen(code, entry, store.all()));
  }, [code, store]);
  useEffect(() => void start(), [start]);
  switch (screen.kind) {
    case 'loading':
      return (
        <>
          <Bar title={t('fd_title')} />
          <main className="page muted">{t('loading')}</main>
        </>
      );
    case 'scan':
      return (
        <>
          <Bar title={t('fd_title')} />
          <main className="page">
            <section className="card">
              <p className="big">{t('fd_scanTitle')}</p>
              <p className="para muted">{t('fd_scanHint')}</p>
            </section>
          </main>
        </>
      );
    case 'entryFailed':
      return (
        <>
          <Bar title={t('fd_title')} />
          <main className="page">
            <div className="banner err" role="alert">
              <ErrorText code={screen.code} />
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => void start()}
            >
              {t('retry')}
            </button>
            {screen.device && (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  screen.device &&
                  setScreen({ kind: 'device', record: screen.device })
                }
              >
                {t('fd_openDevice', { name: screen.device.displayName })}
              </button>
            )}
          </main>
        </>
      );
    case 'roster':
      return (
        <RosterPage
          entry={screen.entry}
          code={screen.code}
          store={store}
          onBound={(record) => setScreen({ kind: 'device', record })}
        />
      );
    case 'device':
      return (
        <DevicePage
          key={screen.record.token}
          record={screen.record}
          store={store}
          canRebind={code !== null}
          onGone={() => void start()}
        />
      );
  }
}

/** U7: anyone holding the code sees current display names; pick yourself, then bind. */
function RosterPage({
  entry,
  code,
  store,
  onBound,
}: {
  entry: EntryDto;
  code: string;
  store: DeviceStore;
  onBound: (r: DeviceRecord) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<EntryDto['roster'][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return [...entry.roster]
      .filter((p) => !q || p.displayName.toLocaleLowerCase().includes(q))
      .sort(
        (a, b) =>
          a.crewName.localeCompare(b.crewName) ||
          a.displayName.localeCompare(b.displayName),
      );
  }, [entry.roster, query]);
  const bind = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    // A retry for the same person resends the same token (the server answers with the same
    // device); another person always gets a fresh token.
    const prior = store.get(entry.project.id);
    const record: DeviceRecord =
      prior && prior.personId === chosen.personId && prior.deviceId === null
        ? prior
        : {
            projectId: entry.project.id,
            projectName: entry.project.name,
            personId: chosen.personId,
            displayName: chosen.displayName,
            token: newToken(),
            deviceId: null,
            last: null,
          };
    store.put(record);
    try {
      const r = await deviceApi(() => null).bind(
        code,
        record.personId,
        record.token,
      );
      const bound = { ...record, deviceId: r.deviceId };
      store.put(bound);
      onBound(bound);
    } catch (e) {
      const c = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      // A definite refusal leaves nothing behind; an unknown outcome keeps the token for retry.
      if (!['NETWORK', 'REQUEST_FAILED', 'RETRY', 'RATE_LIMITED'].includes(c))
        store.remove(record.projectId, record.token);
      setError(c);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Bar title={t('whoAreYou')} sub={entry.project.name} />
      <main className="page">
        <p className="para muted small">{t('fd_rosterHint')}</p>
        <label className="field">
          <span>{t('fd_search')}</span>
          <input
            type="search"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {entry.roster.length === 0 ? (
          <div className="banner warn">{t('fd_rosterEmpty')}</div>
        ) : (
          <ul className="card list plainlist">
            {shown.map((p) => (
              <li key={p.personId}>
                <button
                  type="button"
                  className="rowbtn plain person"
                  onClick={() => {
                    setError(null);
                    setChosen(p);
                  }}
                >
                  <span className="grow">
                    <b>{p.displayName}</b>
                    <span className="muted small">{p.crewName}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
      {chosen && (
        <Sheet
          title={t('fd_isThisYou')}
          onClose={() => !busy && setChosen(null)}
        >
          <p className="big">{chosen.displayName}</p>
          <p className="para muted small">{t('fd_bindWarn')}</p>
          {error && (
            <div className="banner err" role="alert">
              <ErrorText code={error} />
            </div>
          )}
          <button
            type="button"
            className="primary wide"
            disabled={busy}
            onClick={() => void bind()}
          >
            {error ? t('retry') : t('fd_bindThis')}
          </button>
        </Sheet>
      )}
    </>
  );
}

function DevicePage({
  record,
  store,
  canRebind,
  onGone,
}: {
  record: DeviceRecord;
  store: DeviceStore;
  canRebind: boolean;
  onGone: () => void;
}) {
  const { t, locale } = useI18n();
  const api = useMemo(() => deviceApi(() => record.token), [record.token]);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // The newest reading's deadlines, to explain an end after the record is dropped.
  const [latest] = useState(() => ({ last: record.last }));
  const [session] = useState(
    () =>
      new FieldSession<FieldMeDto>(async () => {
        const me = await api.me();
        latest.last = store.seen(
          record.projectId,
          record.token,
          me,
          new Date(),
        );
        return me;
      }, rerender),
  );
  useEffect(() => void session.load(), [session]);
  // The site day can change and the device can be revoked while the page stays open:
  // re-render every minute, and read the device again when the page comes back.
  useEffect(() => {
    const tick = setInterval(rerender, 60_000);
    const back = () => {
      if (document.visibilityState === 'visible') void session.load();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', back);
    };
  }, [session]);
  const view = deviceView(
    session.data,
    session.readError,
    { ...record, last: latest.last },
    new Date(),
  );
  const ended = view.kind === 'ended';
  useEffect(() => {
    // The server no longer accepts this token: it is useless and is dropped.
    if (ended) store.remove(record.projectId, record.token);
  }, [ended, store, record]);
  // Unregister has its own command queue: a retry never resends another kind of command.
  const [releases] = useState(
    () => new FieldSession<null>(async () => null, rerender),
  );
  const [releasing, setReleasing] = useState(false);
  const release = async () => {
    if (
      (await releaseDevice(releases, api, () => crypto.randomUUID())) === 'gone'
    ) {
      store.remove(record.projectId, record.token);
      setReleasing(false);
      onGone();
    }
  };
  const endDevice = (code: string) => session.end(code);
  // A foreman's page has three parts: own check-in, the crew, the quantity report.
  const [tab, setTab] = useState<'me' | 'crew' | 'report'>('me');
  const today = siteToday(session.data?.project.timezone ?? 'UTC');
  const title = session.data?.person.displayName ?? record.displayName;
  const sub = session.data?.project.name ?? record.projectName;

  // Pending and confirmed phones can both be unregistered (a wrong name picked by mistake).
  const releaseButton = canRelease(view) && (
    <button
      type="button"
      className="textbtn center"
      onClick={() => setReleasing(true)}
    >
      {t('fd_release')}
    </button>
  );
  let body;
  if (view.kind === 'loading') body = <p className="muted">{t('loading')}</p>;
  else if (view.kind === 'unreachable')
    body = (
      <>
        <div className="banner err" role="alert">
          <ErrorText code={view.code} />
        </div>
        <button
          type="button"
          className="ghost"
          onClick={() => void session.load()}
        >
          {t('retry')}
        </button>
      </>
    );
  else if (view.kind === 'ended') {
    const reasonKey = `fd_ended_${view.reason}` as const;
    body = (
      <section className="card">
        <p className="big">{t('fd_endedTitle')}</p>
        <p className="para">{t(reasonKey)}</p>
        {canRebind ? (
          <button type="button" className="primary" onClick={onGone}>
            {t('fd_registerAgain')}
          </button>
        ) : (
          <p className="para muted">{t('fd_scanHint')}</p>
        )}
      </section>
    );
  } else if (view.kind === 'pending')
    body = (
      <>
        <PendingCard
          api={api}
          me={view.me}
          reload={() => session.load()}
          onEnded={endDevice}
        />
        {releaseButton}
      </>
    );
  else
    body = (
      <>
        <section className="card">
          <div className="blk-row">
            <h2 className="blk">{fmtDay(today, locale)}</h2>
            <span className="chip ok">{t('fd_confirmed')}</span>
          </div>
          <div className="kv">
            <span>{t('fd_crew')}</span>
            <span>{view.me.crew?.name ?? t('fd_noCrew')}</span>
          </div>
        </section>
        {view.me.foreman && (
          <div className="seg" role="tablist">
            {(['me', 'crew', 'report'] as const).map((k) => {
              const key =
                k === 'me'
                  ? 'fm_tabMe'
                  : k === 'crew'
                    ? 'fm_tabCrew'
                    : 'fm_tabReport';
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  className={tab === k ? 'on' : ''}
                  onClick={() => setTab(k)}
                >
                  {t(key)}
                </button>
              );
            })}
          </div>
        )}
        {/* Kept mounted: an unresolved command and its retry survive a tab switch. */}
        <div hidden={Boolean(view.me.foreman) && tab !== 'me'}>
          <CheckInCard api={api} me={view.me} onEnded={endDevice} />
        </div>
        {view.me.foreman && (
          <>
            <div hidden={tab !== 'crew'}>
              <CrewCard
                api={api}
                me={view.me}
                session={session}
                onEnded={endDevice}
              />
            </div>
            <div hidden={tab !== 'report'}>
              <ReportCard api={api} me={view.me} onEnded={endDevice} />
            </div>
          </>
        )}
        {releaseButton}
      </>
    );
  return (
    <>
      <Bar title={title} sub={sub} />
      <main className="page">{body}</main>
      {releasing && (
        <Sheet
          title={t('fd_release')}
          onClose={() => !releases.busy && setReleasing(false)}
        >
          <p className="para">{t('fd_releaseWarn')}</p>
          {releases.error && (
            <div className="banner err" role="alert">
              <ErrorText code={releases.error} />
            </div>
          )}
          <button
            type="button"
            className="primary wide danger"
            disabled={releases.busy}
            onClick={() => void release()}
          >
            {releases.pending ? t('retry') : t('fd_releaseConfirm')}
          </button>
        </Sheet>
      )}
    </>
  );
}

/**
 * The pending browser shows its own 6-digit code with the chosen name (design §2); the
 * confirmer types it on their own device. The page polls `me` while a code is shown.
 */
function PendingCard({
  api,
  me,
  reload,
  onEnded,
}: {
  api: DeviceApi;
  me: FieldMeDto;
  reload: () => Promise<boolean>;
  onEnded: (code: string) => void;
}) {
  const { t, locale } = useI18n();
  const [challenge, setChallenge] = useState<{
    code: string;
    expiresAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const live = challenge !== null && Date.parse(challenge.expiresAt) > now;
  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 5000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [live, reload]);
  const show = async () => {
    setBusy(true);
    setError(null);
    try {
      setChallenge(await api.challenge());
      setNow(Date.now());
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      setError(code);
      if (ENDED.has(code)) onEnded(code);
    } finally {
      setBusy(false);
    }
  };
  const left = challenge
    ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000))
    : 0;
  const until = me.device.pendingUntil
    ? new Intl.DateTimeFormat(locale, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(me.device.pendingUntil))
    : '';
  return (
    <section className="card">
      <div className="blk-row">
        <h2 className="blk">{t('fd_pendingTitle')}</h2>
        <span className="chip warn">{t('fd_pending')}</span>
      </div>
      <p className="para">{t('fd_pendingHint')}</p>
      {until && (
        <p className="muted small">{t('fd_pendingUntil', { t: until })}</p>
      )}
      {live ? (
        <div className="challenge" aria-live="polite">
          <span className="muted small">{me.person.displayName}</span>
          <b className="num">
            {challenge.code.slice(0, 3)} {challenge.code.slice(3)}
          </b>
          <span className="muted small">{t('fd_codeLeft', { s: left })}</span>
        </div>
      ) : (
        challenge && <p className="warn-t">{t('fd_codeExpired')}</p>
      )}
      {error && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      <button
        type="button"
        className={live ? 'ghost' : 'primary'}
        disabled={busy}
        onClick={() => void show()}
      >
        {challenge ? t('fd_newCode') : t('fd_showCode')}
      </button>
      <button
        type="button"
        className="textbtn center"
        onClick={() => void reload()}
      >
        {t('fd_checkConfirmed')}
      </button>
    </section>
  );
}

export function FieldApp() {
  return (
    <I18nProvider>
      <div id="app">
        <FieldRoot />
      </div>
    </I18nProvider>
  );
}

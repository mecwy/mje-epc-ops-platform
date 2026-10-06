import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import type { OwnedCommands } from '../field/owned-commands.js';
import { fmtDay } from '../report/format.js';
import type { PmOwners } from './pm-owners.js';

interface Row {
  key: string;
  what: string;
  running: boolean;
  unresolved: boolean;
  code: string | null;
  uncertain: boolean;
  retry: () => void;
  giveUp: () => void;
  settling?: 'saved' | 'refused' | 'unknown' | null;
  refresh?: () => void;
}

/** A row for an owner's attempt: running or unresolved, or else its last refusal. */
function ownedRow<D, A>(
  key: string,
  o: OwnedCommands<D, A>,
  what: (a: A) => string,
): Row | null {
  const a = o.current ?? o.refused;
  if (!a || (!o.current && !o.refusal)) return null;
  return {
    key,
    what: what(a),
    running: o.current !== null && o.session.busy,
    unresolved: o.unresolved !== null,
    code: o.current ? o.session.error : o.refusal,
    uncertain: o.current ? true : o.refusalUncertain,
    retry: () => void o.retry(),
    giveUp: () => o.discard(),
  };
}

/**
 * Workspace adoption recovery on every view, plus the existing lost-write-access site bar.
 * Commands stay with their original flows; Retry/Give up share their settlement path and
 * Refresh only reads the original day. Workspace rows reveal scope without business payload.
 */
export function PmOwnedBar({
  owners,
  itemLabel,
  canWrite = false,
  projectLabel,
  adoptionOnly = false,
  includeAdoptions = true,
}: {
  owners: PmOwners;
  itemLabel: (key: string) => string;
  canWrite?: boolean;
  /** Workspace recovery shows only scope, never personnel/quantity/item payload. */
  projectLabel?: string;
  adoptionOnly?: boolean;
  includeAdoptions?: boolean;
}) {
  const { t, locale } = useI18n();
  const s = owners.site;
  const nameOf = (personId: string) =>
    s.roster.data?.assignments.find((a) => a.personId === personId)
      ?.displayName ?? '—';
  const rows: Row[] = [];
  if (!canWrite && !adoptionOnly) {
    const dev = s.devices;
    const devAction = dev.current ?? dev.refused;
    const devKey =
      devAction?.kind === 'confirm'
        ? 'fm_actConfirm'
        : devAction?.kind === 'reject'
          ? 'pm_actReject'
          : 'pm_actRevoke';
    if (devAction && (dev.current || dev.refusal))
      rows.push({
        key: 'devices',
        what: t(devKey, { name: devAction.device.displayName }),
        running: dev.current !== null && dev.session.busy,
        unresolved: dev.unresolved !== null,
        code: dev.current ? dev.session.error : dev.refusal,
        uncertain: dev.current ? true : dev.refusalUncertain,
        retry: () => void dev.retry(),
        giveUp: () => dev.discard(),
      });
    const site = ownedRow('site', s.siteSave, () => t('pm_actSite'));
    if (site) rows.push(site);
    const settings = ownedRow('settings', s.settingsSave, () =>
      t('pm_actSettings'),
    );
    if (settings) rows.push(settings);
    if (s.entry.pending)
      rows.push({
        key: 'entry',
        what: t('pm_actRotate'),
        running: s.entry.busy,
        unresolved: !s.entry.busy,
        code: s.entry.error,
        uncertain: true,
        retry: () => void s.entry.retry(),
        giveUp: () => s.entry.discard(),
      });
    // The QR change's result once answered (a refusal after an unanswered attempt may still
    // have been recorded): kept as a row, never dropped when the command settles.
    else if (s.entry.error && s.entry.error !== 'STALE')
      rows.push({
        key: 'entry',
        what: t('pm_actRotate'),
        running: false,
        unresolved: false,
        code: s.entry.error,
        uncertain: s.entry.errorUncertain,
        retry: () => {},
        giveUp: () => {},
      });
    for (const [day, d] of s.proxyDays()) {
      const r = ownedRow(`proxy:${day}`, d.proxy, (a) =>
        t('pm_actProxy', {
          name: nameOf(a.personId),
          day: fmtDay(day, locale),
        }),
      );
      if (r) rows.push(r);
    }
  }
  for (const [day, flow] of includeAdoptions ? owners.adoptDays() : []) {
    const o = flow.owned;
    const a = flow.active ?? (o.refusal ? o.refused : null);
    if (!a) continue;
    // Retry and Give up through the flow itself: one settlement with the writer's line (the
    // day is read again, "you saw X, now Y" is kept, the day is freed).
    rows.push({
      key: `adopt:${day}`,
      what: t('pm_actAdopt', {
        item: projectLabel ?? itemLabel(a.item),
        day: fmtDay(day, locale),
      }),
      running: flow.stage === 'running' || flow.refreshing,
      unresolved: o.unresolved !== null,
      code: o.current ? o.session.error : flow.active ? null : o.refusal,
      uncertain: o.current ? true : o.refusalUncertain,
      retry: () => void flow.retry(),
      giveUp: () => void flow.discard(),
      settling: flow.settling?.outcome ?? null,
      refresh: () => void flow.refresh(),
    });
  }
  if (rows.length === 0) return null;
  return (
    <section className="card">
      <h2 className="blk">{t('fm_unresolvedTitle')}</h2>
      {!canWrite && !adoptionOnly && (
        <p className="muted small">{t('pm_ownedRoleNote')}</p>
      )}
      <ul className="plainlist">
        {rows.map((r) => (
          <li key={r.key} className="devrow">
            <span className="grow">
              <b>{r.what}</b>
              <span className="warn-t small" role="alert">
                {r.running ? (
                  r.settling ? (
                    t('loading')
                  ) : (
                    t('saving')
                  )
                ) : r.settling ? (
                  r.settling === 'saved' ? (
                    t('dayRereadFailed')
                  ) : r.settling === 'refused' ? (
                    t('dayRereadFailedRefused')
                  ) : (
                    t('dayRereadFailedUnknown')
                  )
                ) : r.code ? (
                  <ErrorText code={r.code} write uncertain={r.uncertain} />
                ) : null}
              </span>
            </span>
            {r.settling && (
              <button
                type="button"
                className="pill"
                disabled={r.running}
                onClick={r.refresh}
              >
                {t('pm_reload')}
              </button>
            )}
            {r.unresolved && (
              <span className="chips">
                <button
                  type="button"
                  className="pill"
                  disabled={r.running}
                  onClick={r.giveUp}
                >
                  {t('pm_giveUp')}
                </button>
                <button
                  type="button"
                  className="pill accent"
                  disabled={r.running}
                  onClick={r.retry}
                >
                  {t('retry')}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

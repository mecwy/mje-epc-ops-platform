import { useState } from 'react';
import {
  ESCALATION_CATEGORIES,
  type EscalationCategory,
  type ReportItemDto,
} from '@mje/contracts';
import type { MessageKey } from '@mje/ui';
import type { IssueAsOf, IssueItem } from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { Chip, Sheet } from '../ui.js';
import { fmtShort } from './format.js';
import type { IssuesHandle, NewIssue } from './useIssues.js';

/** A specific, actionable message for each rejection the issue API can give. */
export function issueErrorKey(code: string | null): MessageKey | null {
  switch (code) {
    case null:
      return null;
    case 'CATEGORY_REQUIRED':
      return 'categoryRequired';
    case 'NEEDS_EXPERT':
      return 'needsExpert';
    case 'DATE_BEFORE_CLOSE':
    case 'DATE_BEFORE_REOPEN':
    case 'DATE_BEFORE_CREATED':
      return 'dateOrder';
    case 'VERSION_CONFLICT':
      return 'conflictReloaded';
    case 'CONFLICT_STALE':
      return 'conflictStale';
    case 'STALE':
      return 'issuesStale';
    case 'READ_ONLY':
    case 'FORBIDDEN':
      return 'forbidden';
    default:
      return 'saveFail';
  }
}

/**
 * Unsent command or failed reload: say which, and offer Retry (the same command, same key).
 * Otherwise the last definite rejection, if any.
 */
export function IssueBanner({ handle }: { handle: IssuesHandle }) {
  const { t } = useI18n();
  if (handle.needsRetry) {
    const key = handle.pending ? 'saveFail' : issueErrorKey(handle.error);
    return (
      <div className="banner err">
        {key ? t(key) : null}{' '}
        <button
          type="button"
          className="pill"
          disabled={handle.busy}
          onClick={() => void handle.retry()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }
  const key = handle.error === 'NETWORK' ? null : issueErrorKey(handle.error);
  return key ? <div className="banner warn">{t(key)}</div> : null;
}

export const CATEGORY_LABEL = {
  progressLag: 'cat_progressLag',
  milestoneRisk: 'cat_milestoneRisk',
  safety: 'cat_safety',
  quality: 'cat_quality',
  externalStop: 'cat_externalStop',
  resourceGap: 'cat_resourceGap',
  costChange: 'cat_costChange',
  subDispute: 'cat_subDispute',
} as const satisfies Record<EscalationCategory, MessageKey>;

function categoryText(
  t: (k: MessageKey) => string,
  category: EscalationCategory | '',
): string {
  if (!category) return '';
  const labelKey = CATEGORY_LABEL[category];
  return t(labelKey);
}

function CategoryChip({ category }: { category: EscalationCategory | '' }) {
  const { t } = useI18n();
  if (!category) return null;
  const labelKey = CATEGORY_LABEL[category];
  return <Chip tone="warn">{t(labelKey)}</Chip>;
}

/** "Needs your attention": escalated issues that are open on the day. */
export function Attention({
  issues,
  onReply,
}: {
  issues: IssueAsOf[];
  onReply: ((id: string) => void) | null;
}) {
  const { t } = useI18n();
  const list = issues.filter((i) => i.escalate && i.status === 'open');
  if (!list.length) return null;
  return (
    <section
      className="card attn"
      aria-label={t('attention', { n: list.length })}
    >
      <h2 className="attn-h">
        <Icon.alert />
        {t('attention', { n: list.length })}
      </h2>
      {list.map((i) => (
        <div className="attn-item" key={i.id}>
          <strong>{i.title}</strong>
          <div className="chips">
            <CategoryChip category={i.category} />
            {i.last && (
              <span className="muted">
                {i.last.kind === 'reply' ? t('replyPrefix') : ''}
                {i.last.text}
              </span>
            )}
          </div>
          {onReply && (
            <button
              type="button"
              className="ghost small"
              onClick={() => onReply(i.id)}
            >
              {t('reply')}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

/** Open issues of the day in the report (as they stood then, for a submitted day). */
export function IssueList({ issues }: { issues: IssueAsOf[] }) {
  const { t, locale } = useI18n();
  const open = issues.filter((i) => i.status === 'open');
  const closedToday = issues.filter((i) => i.closedToday).length;
  return (
    <>
      <span className="muted small">
        {t('openClosed', { a: open.length, b: closedToday })}
      </span>
      {open.map((i) => (
        <div className="issue" key={i.id}>
          <strong>{i.title}</strong>
          <span className="muted small">
            {[
              i.dueOn ? t('dueBy', { d: fmtShort(i.dueOn, locale) }) : '',
              i.last?.text ?? '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <div className="chips">
            <CategoryChip category={i.category} />
            {i.controlled && <Chip tone="warn">{t('needsExpert')}</Chip>}
          </div>
        </div>
      ))}
    </>
  );
}

/** The issues card of the evening form: lag reminders, open issues, new issue. */
export function FillIssues({
  handle,
  items,
  canWrite,
}: {
  handle: IssuesHandle;
  items: ReportItemDto[];
  canWrite: boolean;
}) {
  const { t, label } = useI18n();
  const [sheet, setSheet] = useState<
    | null
    | { kind: 'new'; preset?: Partial<NewIssue> }
    | { kind: 'issue'; id: string }
  >(null);
  const work = items.filter((i) => i.kind === 'work');
  const itemName = (key: string) => {
    const it = work.find((w) => w.key === key);
    return it ? label(it.label) : key;
  };
  const open = (handle.issues ?? []).filter((i) => i.status === 'open');
  const closedToday = (handle.issues ?? []).filter((i) => i.closedToday);
  const disabled = !canWrite || handle.busy || handle.pending;
  return (
    <>
      <div className="blk-row">
        <h2 className="blk">{t('issues')}</h2>
        {canWrite && (
          <button
            type="button"
            className="textbtn"
            disabled={disabled}
            onClick={() => setSheet({ kind: 'new' })}
          >
            + {t('newIssue')}
          </button>
        )}
      </div>
      <IssueBanner handle={handle} />
      {canWrite &&
        handle.lag.map((key) => (
          <div className="suggest" key={key}>
            {t('lagSuggest', { item: itemName(key) })}
            <div className="chips">
              <button
                type="button"
                className="pill accent"
                disabled={disabled}
                onClick={() =>
                  setSheet({
                    kind: 'new',
                    preset: {
                      title: t('lagTitle', { item: itemName(key) }),
                      category: 'progressLag',
                      escalate: true,
                      workItemKey: key,
                    },
                  })
                }
              >
                {t('escalate')}
              </button>
              <button
                type="button"
                className="pill"
                disabled={disabled}
                onClick={() => void handle.dismissLag(key)}
              >
                {t('ignore')}
              </button>
            </div>
          </div>
        ))}
      {open.map((i) => (
        <div className={`irow${i.escalate ? ' hot' : ''}`} key={i.id}>
          <button
            type="button"
            className="grow plain"
            onClick={() => setSheet({ kind: 'issue', id: i.id })}
          >
            <b>{i.title}</b>
            <span className="muted small">
              {[categoryText(t, i.category), i.last?.text ?? '']
                .filter(Boolean)
                .join(' · ')}
            </span>
          </button>
          {canWrite && (
            <button
              type="button"
              className={`switch${i.escalate ? ' on' : ''}`}
              role="switch"
              aria-checked={i.escalate}
              disabled={disabled}
              onClick={() =>
                i.category || i.escalate
                  ? void handle.escalate(i.id, !i.escalate, i.category)
                  : setSheet({ kind: 'issue', id: i.id })
              }
            >
              {t('escalate')}
            </button>
          )}
        </div>
      ))}
      {closedToday.length > 0 && (
        <>
          <h3>{t('closedTab')}</h3>
          {closedToday.map((i) => (
            <div className="irow" key={i.id}>
              <button
                type="button"
                className="grow plain"
                onClick={() => setSheet({ kind: 'issue', id: i.id })}
              >
                <b>{i.title}</b>
                <span className="muted small">
                  {categoryText(t, i.category)}
                </span>
              </button>
            </div>
          ))}
        </>
      )}
      {sheet?.kind === 'new' && (
        <NewIssueSheet
          items={work}
          preset={sheet.preset ?? {}}
          onClose={() => setSheet(null)}
          onCreate={async (x) => {
            if ((await handle.create(x)) === 'ok') setSheet(null);
          }}
        />
      )}
      {sheet?.kind === 'issue' &&
        handle.issues?.find((i) => i.id === sheet.id) && (
          <IssueSheet
            issue={handle.issues.find((i) => i.id === sheet.id)!}
            canWrite={canWrite}
            busy={handle.busy}
            onClose={() => setSheet(null)}
            handle={handle}
          />
        )}
    </>
  );
}

function CategorySelect({
  value,
  onChange,
  disabled,
}: {
  value: EscalationCategory | '';
  onChange: (c: EscalationCategory | '') => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <label className="field">
      <span>{t('category')}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) =>
          onChange(
            (ESCALATION_CATEGORIES as readonly string[]).includes(
              e.target.value,
            )
              ? (e.target.value as EscalationCategory)
              : '',
          )
        }
      >
        <option value="">—</option>
        {ESCALATION_CATEGORIES.map((c) => {
          const labelKey = CATEGORY_LABEL[c];
          return (
            <option key={c} value={c}>
              {t(labelKey)}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function NewIssueSheet({
  items,
  preset,
  onClose,
  onCreate,
}: {
  items: ReportItemDto[];
  preset: Partial<NewIssue>;
  onClose: () => void;
  onCreate: (x: NewIssue) => Promise<void>;
}) {
  const { t, label } = useI18n();
  const [x, setX] = useState<NewIssue>({
    title: '',
    category: '',
    escalate: false,
    controlled: false,
    workItemKey: null,
    dueOn: null,
    note: '',
    ...preset,
  });
  const [busy, setBusy] = useState(false);
  const needsCategory = x.escalate && !x.category;
  return (
    <Sheet title={t('newIssue')} onClose={onClose}>
      <label className="field">
        <span>{t('title')}</span>
        <input
          value={x.title}
          maxLength={200}
          onChange={(e) => setX({ ...x, title: e.target.value })}
        />
      </label>
      <CategorySelect
        value={x.category}
        onChange={(category) => setX({ ...x, category })}
      />
      <label className="checkline">
        <input
          type="checkbox"
          checked={x.escalate}
          onChange={(e) => setX({ ...x, escalate: e.target.checked })}
        />
        {t('escalateLong')}
      </label>
      {needsCategory && (
        <div className="banner warn">{t('categoryRequired')}</div>
      )}
      <label className="checkline">
        <input
          type="checkbox"
          checked={x.controlled}
          onChange={(e) => setX({ ...x, controlled: e.target.checked })}
        />
        {t('needsExpert')}
      </label>
      <label className="field">
        <span>{t('linkTo')}</span>
        <select
          value={x.workItemKey ?? ''}
          onChange={(e) => setX({ ...x, workItemKey: e.target.value || null })}
        >
          <option value="">—</option>
          {items.map((i) => (
            <option key={i.key} value={i.key}>
              {label(i.label)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('due')}</span>
        <input
          type="date"
          value={x.dueOn ?? ''}
          onChange={(e) => setX({ ...x, dueOn: e.target.value || null })}
        />
      </label>
      <label className="field">
        <span>{t('noteOptional')}</span>
        <textarea
          rows={2}
          maxLength={2000}
          value={x.note}
          onChange={(e) => setX({ ...x, note: e.target.value })}
        />
      </label>
      <button
        type="button"
        className="primary wide"
        disabled={busy || !x.title.trim() || needsCategory}
        onClick={async () => {
          setBusy(true);
          try {
            await onCreate({
              ...x,
              title: x.title.trim(),
              note: x.note.trim(),
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('save')}
      </button>
    </Sheet>
  );
}

function IssueSheet({
  issue,
  canWrite,
  busy,
  onClose,
  handle,
}: {
  issue: IssueItem;
  canWrite: boolean;
  busy: boolean;
  onClose: () => void;
  handle: IssuesHandle;
}) {
  const { t, locale } = useI18n();
  const [text, setText] = useState('');
  const [category, setCategory] = useState<EscalationCategory | ''>(
    issue.category,
  );
  const disabled = !canWrite || busy || handle.pending;
  return (
    <Sheet title={issue.title} onClose={onClose}>
      <div className="chips">
        <CategoryChip category={issue.category} />
        {issue.escalate && <Chip tone="warn">{t('escalated')}</Chip>}
        {issue.controlled && <Chip tone="warn">{t('needsExpert')}</Chip>}
        {issue.status === 'closed' && <Chip>{t('closedTab')}</Chip>}
      </div>
      <div className="notes">
        {issue.notes.map((n) => (
          <p key={n.id}>
            <span className="muted small">{fmtShort(n.onDate, locale)} </span>
            {n.kind === 'reply' ? t('replyPrefix') : ''}
            {n.text}
          </p>
        ))}
      </div>
      {canWrite && (
        <>
          <label className="field">
            <span>{t('note')}</span>
            <textarea
              rows={2}
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="ghost"
            disabled={disabled || !text.trim()}
            onClick={async () => {
              if ((await handle.note(issue.id, text.trim())) === 'ok')
                setText('');
            }}
          >
            {t('send')}
          </button>
          <CategorySelect
            value={category}
            onChange={setCategory}
            disabled={disabled}
          />
          <button
            type="button"
            className={`switch${issue.escalate ? ' on' : ''}`}
            role="switch"
            aria-checked={issue.escalate}
            disabled={disabled || (!issue.escalate && !category)}
            onClick={() =>
              void handle.escalate(issue.id, !issue.escalate, category)
            }
          >
            {t('escalateLong')}
          </button>
          {!issue.escalate && !category && (
            <p className="muted small">{t('categoryRequired')}</p>
          )}
          {/* Current state decides the action; status is as of the shown day. */}
          {issue.state !== 'CLOSED' ? (
            issue.controlled ? (
              <p className="muted small">{t('needsExpert')}</p>
            ) : (
              <button
                type="button"
                className="ghost"
                disabled={disabled}
                onClick={() => void handle.close(issue.id)}
              >
                {t('close')}
              </button>
            )
          ) : (
            <button
              type="button"
              className="ghost"
              disabled={disabled}
              onClick={() => void handle.reopen(issue.id)}
            >
              {t('reopen')}
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}

/**
 * Executive reply to an escalated issue; written into the issue's notes. A reply whose
 * outcome is unknown stays pending here and is resent unchanged by Retry, never re-sent as
 * a new reply.
 */
export function ReplySheet({
  handle,
  issueId,
  onClose,
}: {
  handle: IssuesHandle;
  issueId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  return (
    <Sheet title={t('reply')} onClose={onClose}>
      <IssueBanner handle={handle} />
      <label className="field">
        <span>{t('reply')}</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={text}
          disabled={handle.pending}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary wide"
        disabled={handle.busy || handle.pending || !text.trim()}
        onClick={async () => {
          if ((await handle.reply(issueId, text.trim())) === 'ok') onClose();
        }}
      >
        {t('send')}
      </button>
    </Sheet>
  );
}

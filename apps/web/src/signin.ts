import type { DayFactsDto } from '@mje/contracts';
import type { MessageKey } from '@mje/ui';

/** Pure parts of the Microsoft sign-in flow (no MSAL, no React), so they can be unit-tested. */

export type Interaction = 'redirect' | 'popup';

/**
 * Full-page redirect everywhere. Phones and in-app browsers (WeChat, Safari) block or lose
 * popups. The popup is kept only where a redirect cannot work and a popup can: the page is
 * embedded in a frame (MSAL refuses to redirect inside one) on a desktop with a fine pointer.
 */
export function chooseInteraction(env: {
  embedded: boolean;
  finePointer: boolean;
}): Interaction {
  return env.embedded && env.finePointer ? 'popup' : 'redirect';
}

export interface SignInFailure {
  key: MessageKey;
  /** A support code (MSAL error code or AADSTS number); never the message text. */
  code: string | null;
}

const CATEGORY = new Map<string, MessageKey>([
  ['user_cancelled', 'signInCancelled'],
  ['popup_window_error', 'signInBlocked'],
  ['empty_window_error', 'signInBlocked'],
  ['redirect_in_iframe', 'signInBlocked'],
  ['block_iframe_reload', 'signInBlocked'],
  ['block_nested_popups', 'signInBlocked'],
  ['interaction_in_progress', 'signInBusy'],
  ['no_network_connectivity', 'signInNetwork'],
  ['post_request_failed', 'signInNetwork'],
  ['get_request_failed', 'signInNetwork'],
  ['endpoints_resolution_error', 'signInNetwork'],
  ['network_error', 'signInNetwork'],
  ['timed_out', 'signInNetwork'],
  ['state_mismatch', 'signInInterrupted'],
  ['state_not_found', 'signInInterrupted'],
  ['nonce_mismatch', 'signInInterrupted'],
  ['hash_empty_error', 'signInInterrupted'],
  ['no_state_in_hash', 'signInInterrupted'],
  ['hash_does_not_contain_known_properties', 'signInInterrupted'],
  ['unable_to_parse_state', 'signInInterrupted'],
  ['no_token_request_cache_error', 'signInInterrupted'],
  ['access_denied', 'signInRejected'],
  ['invalid_request', 'signInRejected'],
  ['unauthorized_client', 'signInRejected'],
  ['invalid_client', 'signInRejected'],
  ['consent_required', 'signInRejected'],
]);

/** Which message a failed sign-in shows, by MSAL error code category (duck-typed AuthError). */
export function signInFailure(error: unknown): SignInFailure {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown;
    errorCode?: unknown;
    errorMessage?: unknown;
  };
  const code =
    typeof e.errorCode === 'string' && /^[a-z0-9_]{1,64}$/.test(e.errorCode)
      ? e.errorCode
      : null;
  const aadsts =
    typeof e.errorMessage === 'string'
      ? (/AADSTS\d{4,8}/.exec(e.errorMessage)?.[0] ?? null)
      : null;
  const key =
    (code !== null ? CATEGORY.get(code) : undefined) ??
    (e.name === 'ServerError' ? 'signInRejected' : 'signInFailed');
  return { key, code: aadsts ?? code };
}

/** MSAL's interaction lock: `msal.interaction.status` in session storage, JSON {clientId, type}. */
export const INTERACTION_KEY = 'msal.interaction.status';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Remove a lock this app left in this tab (for example: the user came Back from the Microsoft
 * page and the browser restored this page from its cache). Only call it when no sign-in of
 * this page is running. Another app's lock is left alone. Returns whether it removed one.
 */
export function clearStaleInteraction(storage: Store, clientId: string) {
  const raw = storage.getItem(INTERACTION_KEY);
  if (raw === null) return false;
  let owner: unknown;
  try {
    owner = (JSON.parse(raw) as { clientId?: unknown } | null)?.clientId;
  } catch {
    owner = clientId; // unreadable: MSAL itself would discard it
  }
  if (owner !== clientId) return false;
  storage.removeItem(INTERACTION_KEY);
  return true;
}

/** What is put aside for a sign-in round trip. No tokens: MSAL keeps its own. */
export interface DraftStash {
  projectId: string;
  businessDate: string;
  /** The version the unsaved facts were typed on. */
  version: number;
  facts: DayFactsDto;
}
export type View = 'field' | 'report';
export interface ResumeState {
  projectId: string;
  date: string;
  view: View;
  drafts: DraftStash[];
  /** When the first redirect of this recovery put it aside (ms since epoch). */
  savedAt: number;
}

const RESUME_KEY = 'mje-resume';
/** Bounds on what a page load will take back: age, days and total size. */
export const RESUME_LIMITS = {
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxDrafts: 31,
  /** UTF-8 bytes of the stored JSON. */
  maxBytes: 512 * 1024,
};
const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isMap = (v: unknown, ok: (x: unknown) => boolean) =>
  isObj(v) && Object.values(v).length <= 500 && Object.values(v).every(ok);
const isStr = (v: unknown) => typeof v === 'string';

/**
 * The shape of DayFactsDto, without the server's value rules: unsaved text that the server
 * would still refuse (for example "12,5" or "abc" in a quantity) is the user's and is kept.
 */
export function isFactsShape(v: unknown): v is DayFactsDto {
  if (!isObj(v)) return false;
  const n = v['narrative'];
  const w = v['noWork'];
  return (
    isStr(v['weather']) &&
    isStr(v['temperature']) &&
    isObj(n) &&
    isStr(n['construction']) &&
    isStr(n['quality']) &&
    isStr(n['safety']) &&
    ['qty', 'cumulative', 'people', 'machinery', 'materials', 'updated'].every(
      (k) => isMap(v[k], isStr),
    ) &&
    isMap(
      v['presence'],
      (x) => x === 'present' || x === 'absent' || x === '',
    ) &&
    isMap(
      v['milestones'],
      (x) => isObj(x) && isStr(x['actual']) && isStr(x['note']),
    ) &&
    (w === null || (isObj(w) && isStr(w['reason']) && isStr(w['note'])))
  );
}
const isDraft = (v: unknown): v is DraftStash =>
  isObj(v) &&
  typeof v['projectId'] === 'string' &&
  isDate(v['businessDate']) &&
  Number.isInteger(v['version']) &&
  isFactsShape(v['facts']);
const draftKey = (d: { projectId: string; businessDate: string }) =>
  `${d.projectId}:${d.businessDate}`;

/** A UTF-16 code unit is at least one UTF-8 byte, so long strings are refused unencoded. */
const withinBytes = (raw: string) =>
  raw.length <= RESUME_LIMITS.maxBytes &&
  new TextEncoder().encode(raw).length <= RESUME_LIMITS.maxBytes;

/** Returns false if it could not be stored (private mode, quota, over the limits). */
export function saveResume(storage: Store | null, state: ResumeState) {
  if (!storage || state.drafts.length > RESUME_LIMITS.maxDrafts) return false;
  const raw = JSON.stringify(state);
  if (!withinBytes(raw)) return false;
  try {
    storage.setItem(RESUME_KEY, raw);
    return true;
  } catch {
    return false;
  }
}
export function clearResume(storage: Store | null) {
  try {
    storage?.removeItem(RESUME_KEY);
  } catch {
    /* nothing to keep */
  }
}

/**
 * Read (not remove) the state saved before a redirect. Anything malformed, too old or too
 * large is dropped and removed; a malformed draft is dropped on its own.
 */
export function readResume(
  storage: Store | null,
  now: number,
): ResumeState | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(RESUME_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let s: unknown = null;
  if (withinBytes(raw))
    try {
      s = JSON.parse(raw);
    } catch {
      s = null;
    }
  if (
    !isObj(s) ||
    typeof s['projectId'] !== 'string' ||
    !isDate(s['date']) ||
    (s['view'] !== 'field' && s['view'] !== 'report') ||
    !Array.isArray(s['drafts']) ||
    s['drafts'].length > RESUME_LIMITS.maxDrafts ||
    typeof s['savedAt'] !== 'number' ||
    !(s['savedAt'] <= now && now - s['savedAt'] <= RESUME_LIMITS.maxAgeMs)
  ) {
    clearResume(storage);
    return null;
  }
  return {
    projectId: s['projectId'],
    date: s['date'],
    view: s['view'],
    drafts: s['drafts'].filter(isDraft),
    savedAt: s['savedAt'],
  };
}

const sameDraft = (a: DraftStash, b: DraftStash) =>
  draftKey(a) === draftKey(b) &&
  a.version === b.version &&
  canonical(a.facts) === canonical(b.facts);

/**
 * Owns the resume state across sign-in round trips. The stored copy keeps a draft until its
 * day has been reconciled and any re-applied facts acknowledged, so a cancelled or failed
 * sign-in, a reload or a second redirect before that point loses nothing.
 */
export class ResumeKeeper {
  readonly state: ResumeState | null;
  /** Drafts not yet handed to their day. */
  private readonly pending = new Map<string, DraftStash>();
  /** What storage holds now: the stash read at load, or the latest snapshot saved. */
  private stored: ResumeState | null;
  private snapshotSaved = false;

  constructor(
    private readonly storage: Store | null,
    now: number,
  ) {
    this.state = readResume(storage, now);
    this.stored = this.state;
    for (const d of this.state?.drafts ?? []) this.pending.set(draftKey(d), d);
  }

  /** The workspace opened on `projectId`: the view is restored; other projects' drafts go. */
  opened(projectId: string) {
    for (const [k, d] of this.pending)
      if (d.projectId !== projectId) this.pending.delete(k);
    if (this.stored)
      this.write({
        ...this.stored,
        drafts: this.stored.drafts.filter((d) => d.projectId === projectId),
      });
  }
  get pendingCount() {
    return this.pending.size;
  }
  /** The draft still waiting for its day, if any. */
  draft(projectId: string, businessDate: string): DraftStash | null {
    return this.pending.get(draftKey({ projectId, businessDate })) ?? null;
  }
  /** Its day took it (it is not offered again); the stored copy stays until `resolved`. */
  taken(stash: DraftStash) {
    this.pending.delete(draftKey(stash));
  }
  /**
   * The draft needs no keeping any more: found saved, refused as a conflict, or re-applied
   * and acknowledged. Only that very draft leaves the stored copy (a newer snapshot entry of
   * the same day, and every other entry, stay).
   */
  resolved(stash: DraftStash) {
    this.taken(stash);
    if (this.stored)
      this.write({
        ...this.stored,
        drafts: this.stored.drafts.filter((d) => !sameDraft(d, stash)),
      });
  }
  /**
   * Before another redirect: the current place, every unsaved day, and every draft not yet
   * handed to its day (an unsaved day wins over its older stashed draft). Stamped now; drafts
   * from a stash older than the age limit are left out so the rest stays readable. True only
   * if the snapshot was stored.
   */
  save(
    place: { projectId: string; date: string; view: View },
    unsaved: DraftStash[],
    now: number,
  ): boolean {
    const fresh =
      this.state !== null &&
      this.state.savedAt <= now &&
      now - this.state.savedAt <= RESUME_LIMITS.maxAgeMs;
    const drafts = new Map(fresh ? this.pending : []);
    for (const d of unsaved) drafts.set(draftKey(d), d);
    const next = { ...place, drafts: [...drafts.values()], savedAt: now };
    if (!saveResume(this.storage, next)) return false;
    this.stored = next;
    this.snapshotSaved = true;
    return true;
  }
  /** A snapshot keeps its place even without drafts; the load-time stash is then done. */
  private write(next: ResumeState) {
    if (next.drafts.length === 0 && !this.snapshotSaved) {
      clearResume(this.storage);
      this.stored = null;
    } else if (saveResume(this.storage, next)) this.stored = next;
  }
}

/**
 * One renewal at a time: the guard is taken synchronously on the first click, before the
 * bounded flush, and held through the snapshot and the redirect start. It is released when
 * the redirect call fails or returns, or by `reset()` when the page comes back from the
 * back-forward cache.
 */
export function renewal(steps: {
  flush: () => Promise<unknown>;
  snapshot: () => boolean;
  redirect: () => Promise<void>;
  flushMs?: number;
}) {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    reset() {
      busy = false;
    },
    async start(): Promise<'busy' | 'unsaved' | 'done'> {
      if (busy) return 'busy';
      busy = true;
      try {
        await Promise.race([
          steps.flush().catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, steps.flushMs ?? 1500)),
        ]);
        if (!steps.snapshot()) return 'unsaved';
        await steps.redirect();
        return 'done';
      } finally {
        busy = false;
      }
    },
  };
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );

/**
 * A stashed draft meets the day as read after the return:
 * - `saved`: the server already has exactly these facts (the last write did land);
 * - `apply`: nothing changed on the server since they were typed, so they are re-applied and
 *   saved with that version as expectedVersion;
 * - `conflict`: the day moved on; a newer server state is never overwritten.
 */
export function restoreDecision(
  stash: DraftStash,
  server: { version: number; facts: DayFactsDto },
): 'saved' | 'apply' | 'conflict' {
  if (canonical(stash.facts) === canonical(server.facts)) return 'saved';
  return server.version === stash.version ? 'apply' : 'conflict';
}

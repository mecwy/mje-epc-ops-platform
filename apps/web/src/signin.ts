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
}

const RESUME_KEY = 'mje-resume';
const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isDraft = (v: unknown): v is DraftStash => {
  const d = v as Partial<DraftStash> | null;
  return (
    typeof d === 'object' &&
    d !== null &&
    typeof d.projectId === 'string' &&
    isDate(d.businessDate) &&
    Number.isInteger(d.version) &&
    typeof d.facts === 'object' &&
    d.facts !== null
  );
};

/** Returns false if it could not be stored (private mode, quota). */
export function saveResume(storage: Store | null, state: ResumeState) {
  try {
    storage?.setItem(RESUME_KEY, JSON.stringify(state));
    return storage !== null;
  } catch {
    return false;
  }
}

/** Read and remove the state saved before the redirect; anything malformed is dropped. */
export function takeResume(storage: Store | null): ResumeState | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(RESUME_KEY) ?? null;
    storage?.removeItem(RESUME_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const s = JSON.parse(raw) as Partial<ResumeState> | null;
    if (
      !s ||
      typeof s.projectId !== 'string' ||
      !isDate(s.date) ||
      (s.view !== 'field' && s.view !== 'report') ||
      !Array.isArray(s.drafts)
    )
      return null;
    return {
      projectId: s.projectId,
      date: s.date,
      view: s.view,
      drafts: s.drafts.filter(isDraft),
    };
  } catch {
    return null;
  }
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

import type { MessageKey } from '@mje/ui';

/**
 * Every field, check-in, binding, roster, foreman and adoption code the API returns (the
 * domain's FieldErrorCode plus the report codes adopt uses), each with its own user message.
 * Messages are chosen only by code and never repeat a name, code or coordinate. A status
 * refusal may also carry sanitized fixed field names, handled by the status form separately.
 * errors.test.ts checks this table against the domain's FieldErrorCode at compile time and
 * that no two codes share a message (INVALID_JSON is INVALID_INPUT's transport form).
 */
export const FIELD_ERRORS = {
  FIELD_AUTH_REQUIRED: 'fe_authRequired',
  DEVICE_ENDED: 'fe_deviceEnded',
  DEVICE_PENDING: 'fe_devicePending',
  FORBIDDEN: 'forbidden',
  NOT_FOREMAN: 'fe_notForeman',
  SELF_CONFIRM: 'fe_selfConfirm',
  NOT_FOUND: 'fe_notFound',
  ENTRY_CODE_INVALID: 'fe_entryInvalid',
  PERSON_NOT_ROSTERED: 'fe_notRostered',
  RATE_LIMITED: 'fe_rateLimited',
  RETRY: 'fe_retry',
  TOKEN_CONFLICT: 'fe_tokenConflict',
  TOO_MANY_PENDING: 'fe_tooManyPending',
  CHALLENGE_INVALID: 'fe_challengeInvalid',
  CONFIRM_STALE: 'fe_confirmStale',
  VERSION_CONFLICT: 'conflictReloaded',
  STATUS_FIELDS_REQUIRED: 'fe_statusFieldsRequired',
  IDEMPOTENCY_KEY_REUSED: 'fe_keyReused',
  ASSIGNMENT_OVERLAP: 'fe_assignmentOverlap',
  ASSIGNMENT_CLOSED: 'fe_assignmentClosed',
  ROSTER_TIME_INVALID: 'fe_rosterTime',
  CREW_ENDED: 'fe_crewEnded',
  CREW_NOT_EMPTY: 'fe_crewNotEmpty',
  CREW_CODE_TAKEN: 'fe_crewCodeTaken',
  PROXY_NOT_ALLOWED: 'proxyNotAllowed',
  FEATURE_OFF: 'fe_featureOff',
  FIX_TIME_INVALID: 'fe_fixTime',
  TIME_ORDER_INVALID: 'fe_timeOrder',
  DEVICE_CLOCK_SKEW: 'fe_clockSkew',
  TOO_LATE: 'fe_tooLate',
  BUSINESS_DAY_MISMATCH: 'fe_dayMismatch',
  LOCATION_TOO_COARSE: 'fe_tooCoarse',
  GEOFENCE_OUTSIDE: 'fe_outside',
  SITE_NOT_CONFIGURED: 'fe_siteNotSet',
  ALREADY_CHECKED_IN: 'already',
  REASON_REQUIRED: 'fe_reasonRequired',
  SELFIE_EXPIRED: 'fe_selfieExpired',
  SELFIE_TOO_LARGE: 'fe_selfieTooLarge',
  UNSUPPORTED_MEDIA: 'photoUnsupported',
  REVISION_CONFLICT: 'fe_revisionConflict',
  NUMBER_INVALID: 'numberInvalid',
  ITEM_NOT_FOUND: 'fe_itemNotFound',
  // client-only: a report typed for another crew or day is never sent (C57)
  CREW_CHANGED: 'fe_crewChanged',
  // adoption (report store) and the shared transport codes
  FOREMAN_TOTAL_CHANGED: 'fe_totalChanged',
  ADOPT_NOT_COMPLETE: 'fe_adoptIncomplete',
  LOCKED: 'locked',
  READ_ONLY: 'fe_readOnly',
  LOGIN_REQUIRED: 'signInExpired',
  INVALID_INPUT: 'fe_invalid',
  INVALID_JSON: 'fe_invalid',
  NETWORK: 'fe_network',
  STALE: 'loadFail',
  REQUEST_FAILED: 'fe_failed',
} as const satisfies Record<string, MessageKey>;
export type KnownFieldCode = keyof typeof FIELD_ERRORS;

/**
 * Refusals the server makes before it replays a key's stored answer (authority is re-checked
 * first, C57): after an earlier attempt of the same command went unanswered, such a refusal
 * does not mean nothing was recorded, so it gets its own message and nothing is resent.
 */
export const REFUSED_BEFORE_REPLAY = {
  NOT_FOREMAN: 'fe_notForemanMaybeRecorded',
  PROXY_NOT_ALLOWED: 'fe_proxyMaybeRecorded',
  // PM writes (report-store `writer`, checkin-store `pm`, field-store `pm`): project access
  // is checked before the replay, and sign-in before the request reaches the store.
  FORBIDDEN: 'fe_accessMaybeRecorded',
  READ_ONLY: 'fe_accessMaybeRecorded',
  LOGIN_REQUIRED: 'fe_signInMaybeRecorded',
} as const satisfies Partial<Record<KnownFieldCode, MessageKey>>;

/**
 * Unsettled codes of a write (session.ts UNSETTLED): the command is kept for an unchanged Retry
 * and its outcome is not known, so each has an unknown-outcome message and never a failure
 * ("did not succeed", "nothing was saved").
 */
export const UNKNOWN_OUTCOME = {
  NETWORK: 'fu_network',
  REQUEST_FAILED: 'fu_server',
  RETRY: 'fu_busy',
  RATE_LIMITED: 'fu_limited',
} as const satisfies Partial<Record<KnownFieldCode, MessageKey>>;

/**
 * The one mapping for a command's outcome on every field surface (AGENTS.md):
 * - a write whose code is unsettled → unknown outcome (UNKNOWN_OUTCOME);
 * - a refusal made before the replay (REFUSED_BEFORE_REPLAY) after an unanswered attempt
 *   (`uncertain`) → "may already have been recorded";
 * - any other refusal (the server decided) → its own message.
 * A read's error is not a write: it keeps its own message.
 */
export function outcomeKey(
  code: string | null | undefined,
  o: { write: boolean; uncertain: boolean },
): MessageKey {
  if (o.write && code && Object.hasOwn(UNKNOWN_OUTCOME, code))
    return UNKNOWN_OUTCOME[code as keyof typeof UNKNOWN_OUTCOME];
  return o.uncertain && code && Object.hasOwn(REFUSED_BEFORE_REPLAY, code)
    ? REFUSED_BEFORE_REPLAY[code as keyof typeof REFUSED_BEFORE_REPLAY]
    : fieldErrorKey(code);
}

/** The message for any code; an unknown code gets the generic failure, never its raw text. */
export function fieldErrorKey(code: string | null | undefined): MessageKey {
  return code && Object.hasOwn(FIELD_ERRORS, code)
    ? FIELD_ERRORS[code as KnownFieldCode]
    : 'fe_failed';
}

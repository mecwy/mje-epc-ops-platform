import type { MessageKey } from '@mje/ui';

/**
 * Every field, check-in, binding, roster, foreman and adoption code the API returns (the
 * domain's FieldErrorCode plus the report codes adopt uses), each with its own user message.
 * The error body carries only a code; the message never repeats a name, code or coordinate.
 * errors.test.ts checks this table against the domain's FieldErrorCode at compile time.
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
  IDEMPOTENCY_KEY_REUSED: 'fe_keyReused',
  ASSIGNMENT_OVERLAP: 'fe_roster',
  ASSIGNMENT_CLOSED: 'fe_roster',
  ROSTER_TIME_INVALID: 'fe_roster',
  CREW_ENDED: 'fe_roster',
  CREW_NOT_EMPTY: 'fe_roster',
  CREW_CODE_TAKEN: 'fe_roster',
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
  // adoption (report store) and the shared transport codes
  FOREMAN_TOTAL_CHANGED: 'fe_totalChanged',
  ADOPT_NOT_COMPLETE: 'fe_adoptIncomplete',
  LOCKED: 'locked',
  READ_ONLY: 'forbidden',
  LOGIN_REQUIRED: 'signInExpired',
  INVALID_INPUT: 'fe_invalid',
  INVALID_JSON: 'fe_invalid',
  NETWORK: 'fe_network',
  STALE: 'loadFail',
  REQUEST_FAILED: 'fe_failed',
} as const satisfies Record<string, MessageKey>;
export type KnownFieldCode = keyof typeof FIELD_ERRORS;

/** The message for any code; an unknown code gets the generic failure, never its raw text. */
export function fieldErrorKey(code: string | null | undefined): MessageKey {
  return code && Object.hasOwn(FIELD_ERRORS, code)
    ? FIELD_ERRORS[code as KnownFieldCode]
    : 'fe_failed';
}

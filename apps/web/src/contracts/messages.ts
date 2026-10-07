import type { MessageKey } from '@mje/ui';
import type { I18n } from '../i18n.js';
export function message(t: I18n['t'], key: MessageKey) {
  return t(key);
}
export function failureKey(code: string | null, uncertain = false): MessageKey {
  if (
    uncertain ||
    code === 'NETWORK' ||
    code === 'REQUEST_FAILED' ||
    code === 'RETRY' ||
    code === 'RATE_LIMITED'
  )
    return 'ctUncertain';
  if (
    code === 'FORBIDDEN' ||
    code === 'LOGIN_REQUIRED' ||
    code === 'UNAUTHORIZED'
  )
    return 'ctForbidden';
  if (code === 'VERSION_CONFLICT' || code === 'IDENTITY_EXISTS')
    return 'ctConflict';
  if (code === 'SHARE_INVALID' || code === 'RECONCILE_REQUIRED')
    return 'ctShareInvalid';
  return 'ctInvalid';
}
export function readFailureKey(code: string | null): MessageKey {
  return code === 'FORBIDDEN' ||
    code === 'LOGIN_REQUIRED' ||
    code === 'UNAUTHORIZED'
    ? 'ctForbidden'
    : 'ctReadFailed';
}

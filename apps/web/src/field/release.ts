import type { DeviceApi } from './field-api.js';
import { ENDED, type FieldSession } from './session.js';

/**
 * Unregister this phone (`device/release`, keyed). The first attempt and every retry end the
 * same way: success, or an ended device (a release that committed while its answer was
 * lost is then refused as ended), means the phone is no longer registered and the caller
 * drops the token; anything unresolved keeps the command for an unchanged retry.
 */
export async function releaseDevice(
  queue: FieldSession<null>,
  api: Pick<DeviceApi, 'release'>,
  newKey: () => string,
): Promise<'gone' | 'kept'> {
  const r = queue.pending
    ? await queue.retry()
    : await queue.act(() => {
        const key = newKey();
        return { key, send: () => api.release(key) };
      }, false);
  if (r.kind === 'ok') return 'gone';
  if (r.kind === 'rejected' && ENDED.has(r.code)) return 'gone';
  return 'kept';
}

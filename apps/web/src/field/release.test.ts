import { describe, expect, it } from 'vitest';
import { FieldApiError } from './field-api.js';
import { releaseDevice } from './release.js';
import { FieldSession } from './session.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
function harness() {
  const sent: { key: string; settle: (e?: Error) => void }[] = [];
  const api = {
    release: (key: string) =>
      new Promise<unknown>((resolve, reject) =>
        sent.push({ key, settle: (e) => (e ? reject(e) : resolve({})) }),
      ),
  };
  let n = 0;
  const queue = new FieldSession<null>(
    async () => null,
    () => {},
  );
  const run = () => releaseDevice(queue, api, () => `R${++n}`);
  return { sent, run, queue };
}

describe('unregister this phone (#4)', () => {
  it('a retry after a lost answer completes the same way as a first success', async () => {
    const { sent, run, queue } = harness();
    const first = run();
    await tick();
    sent[0]!.settle(new FieldApiError('NETWORK', 0));
    expect(await first).toBe('kept');
    expect(queue.pending?.key).toBe('R1');
    const second = run();
    await tick();
    // The same command and key are resent, not a new release.
    expect(sent[1]!.key).toBe('R1');
    sent[1]!.settle();
    expect(await second).toBe('gone');
    expect(queue.pending).toBeNull();
  });
  it('a release that committed while its answer was lost is refused as ended: the phone is unregistered', async () => {
    for (const code of ['DEVICE_ENDED', 'FIELD_AUTH_REQUIRED']) {
      const { sent, run } = harness();
      const first = run();
      await tick();
      sent[0]!.settle(new FieldApiError('RETRY', 503));
      expect(await first).toBe('kept');
      const again = run();
      await tick();
      sent[1]!.settle(new FieldApiError(code, 401));
      expect(await again).toBe('gone');
    }
  });
  it('any other refusal keeps the device', async () => {
    const { sent, run } = harness();
    const r = run();
    await tick();
    sent[0]!.settle(new FieldApiError('INVALID_INPUT', 400));
    expect(await r).toBe('kept');
  });
});

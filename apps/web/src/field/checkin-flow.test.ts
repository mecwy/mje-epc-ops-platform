import { describe, expect, it } from 'vitest';
import type {
  CaptureFixDto,
  CheckInCommand,
  CheckInResultDto,
  SelfieUploadDto,
} from '@mje/contracts';
import { FieldApiError } from './field-api.js';
import { CheckInFlow } from './checkin-flow.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
// TEST coordinates only.
const fix = (at: number): CaptureFixDto => ({
  lat: '1.000000',
  lon: '1.000000',
  accuracyM: '20.00',
  fixAt: new Date(at).toISOString(),
});
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

/** A flow whose network calls the test settles one by one. */
function harness(start = Date.parse('2026-10-02T08:00:00.000Z')) {
  let clock = start;
  let keys = 0;
  const calls: {
    kind: 'checkin' | 'selfie';
    key: string;
    body: unknown;
    settle: (v: unknown) => void;
  }[] = [];
  const ended: string[] = [];
  const call = (kind: 'checkin' | 'selfie') => (key: string, body: unknown) =>
    new Promise((resolve, reject) =>
      calls.push({
        kind,
        key,
        body,
        settle: (v) => (v instanceof Error ? reject(v) : resolve(v)),
      }),
    );
  const flow = new CheckInFlow({
    api: {
      checkIn: (key: string, build: () => CheckInCommand) =>
        call('checkin')(key, build()) as Promise<CheckInResultDto>,
      uploadSelfie: (key: string, image: Blob) =>
        call('selfie')(key, image) as Promise<SelfieUploadDto>,
    },
    deviceId: 'd1',
    timeZone: 'Europe/Belgrade',
    storage: memoryStorage(),
    locate: async () => ({ fix: fix(clock), reason: null }),
    now: () => clock,
    newKey: () => `K${++keys}`,
    onEnded: (c) => ended.push(c),
    notify: () => {},
  });
  return {
    flow,
    calls,
    ended,
    setClock: (t: number) => (clock = t),
  };
}
const result = (over: Partial<CheckInResultDto> = {}): CheckInResultDto => ({
  checkInId: 'c1',
  businessDate: '2026-10-02',
  kind: 'SELF',
  occurredAt: '2026-10-02T08:00:00.000Z',
  timePrecision: 'EXACT',
  flags: [],
  hasSelfie: false,
  afterSubmission: false,
  ...over,
});
const imageA = new Blob(['A'], { type: 'image/jpeg' });
const imageB = new Blob(['B'], { type: 'image/jpeg' });

describe('check-in card state (CheckInFlow)', () => {
  it('#1 a new selfie cannot be chosen while an upload is unresolved; the retry sends and stages the original', async () => {
    const { flow, calls } = harness();
    const first = flow.chooseSelfie(imageA);
    await tick();
    calls[0]!.settle(new FieldApiError('NETWORK', 0));
    await first;
    expect(flow.phase.kind).toBe('unsettled');
    expect(flow.canChooseSelfie).toBe(false);
    expect(await flow.chooseSelfie(imageB)).toBe(false);
    // What is shown is what the retry sends.
    expect(flow.selfie?.image).toBe(imageA);
    const retry = flow.retry();
    await tick();
    expect(calls[1]!.body).toBe(imageA);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    calls[1]!.settle({ selfieId: 'sA', expiresAt: '2026-10-02T09:00:00.000Z' });
    await retry;
    expect(flow.staged?.selfieId).toBe('sA');
    expect(flow.selfie?.image).toBe(imageA);
  });

  it('#1 removing the selfie gives up its unresolved upload; a new one can then be chosen', async () => {
    const { flow, calls } = harness();
    const first = flow.chooseSelfie(imageA);
    await tick();
    calls[0]!.settle(new FieldApiError('NETWORK', 0));
    await first;
    flow.removeSelfie();
    expect(flow.selfie).toBeNull();
    expect(flow.uploads.pending).toBeNull();
    expect(flow.phase.kind).toBe('idle');
    const second = flow.chooseSelfie(imageB);
    await tick();
    expect(calls[1]!.body).toBe(imageB);
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
    calls[1]!.settle({ selfieId: 'sB', expiresAt: '2026-10-02T09:00:00.000Z' });
    expect(await second).toBe(true);
    expect(flow.staged?.selfieId).toBe('sB');
  });

  it('#2 a check-in or selfie refused because the device ended reaches the device lifecycle', async () => {
    const { flow, calls, ended } = harness();
    const run = flow.checkIn();
    await tick();
    calls[0]!.settle(new FieldApiError('DEVICE_ENDED', 401));
    await run;
    expect(ended).toEqual(['DEVICE_ENDED']);
    const up = flow.chooseSelfie(imageA);
    await tick();
    calls[1]!.settle(new FieldApiError('FIELD_AUTH_REQUIRED', 401));
    await up;
    expect(ended).toEqual(['DEVICE_ENDED', 'FIELD_AUTH_REQUIRED']);
    // Other refusals are the card's own business.
    const again = flow.checkIn();
    await tick();
    calls[2]!.settle(new FieldApiError('GEOFENCE_OUTSIDE', 409));
    await again;
    expect(ended).toHaveLength(2);
  });

  it('#6 after SELFIE_EXPIRED the selfie choice is cleared and check-in without it is possible', async () => {
    const { flow, calls } = harness();
    const up = flow.chooseSelfie(imageA);
    await tick();
    calls[0]!.settle({ selfieId: 'sA', expiresAt: '2026-10-02T09:00:00.000Z' });
    await up;
    const run = flow.checkIn();
    await tick();
    expect((calls[1]!.body as CheckInCommand).stagedSelfieId).toBe('sA');
    calls[1]!.settle(new FieldApiError('SELFIE_EXPIRED', 409));
    await run;
    expect(flow.phase).toMatchObject({
      kind: 'refused',
      code: 'SELFIE_EXPIRED',
    });
    expect(flow.selfie).toBeNull();
    expect(flow.canCheckIn).toBe(true);
    const without = flow.checkIn();
    await tick();
    expect((calls[2]!.body as CheckInCommand).stagedSelfieId).toBeNull();
    calls[2]!.settle(result());
    await without;
    expect(flow.doneToday()?.occurredAt).toBe('2026-10-02T08:00:00.000Z');
  });

  it("#7 yesterday's check-in is not shown after the site's midnight; today's can be made", async () => {
    // 23:50 in Belgrade (UTC+2 in October) is 21:50 UTC.
    const h = harness(Date.parse('2026-10-02T21:50:00.000Z'));
    const run = h.flow.checkIn();
    await tick();
    h.calls[0]!.settle(
      result({
        businessDate: '2026-10-02',
        occurredAt: '2026-10-02T21:50:00.000Z',
      }),
    );
    await run;
    expect(h.flow.doneToday()?.businessDate).toBe('2026-10-02');
    // 00:01 site time: a new site day, although it is still 2 October in UTC.
    h.setClock(Date.parse('2026-10-02T22:01:00.000Z'));
    expect(h.flow.today()).toBe('2026-10-03');
    expect(h.flow.doneToday()).toBeNull();
    expect(h.flow.canCheckIn).toBe(true);
    const next = h.flow.checkIn();
    await tick();
    expect((h.calls[1]!.body as CheckInCommand).businessDate).toBe(
      '2026-10-03',
    );
    h.calls[1]!.settle(
      result({
        businessDate: '2026-10-03',
        occurredAt: '2026-10-02T22:01:00.000Z',
      }),
    );
    await next;
    expect(h.flow.doneToday()?.businessDate).toBe('2026-10-03');
  });

  it('ALREADY_CHECKED_IN is remembered for the day of the event, and a retry resends the same event', async () => {
    const { flow, calls } = harness();
    const run = flow.checkIn();
    await tick();
    calls[0]!.settle(new FieldApiError('NETWORK', 0));
    await run;
    expect(flow.phase.kind).toBe('unsettled');
    const again = flow.retry();
    await tick();
    expect(calls[1]!.key).toBe(calls[0]!.key);
    calls[1]!.settle(
      new FieldApiError('ALREADY_CHECKED_IN', 409, {
        occurredAt: '2026-10-02T07:00:00.000Z',
        kind: 'FOREMAN_PROXY',
      }),
    );
    await again;
    expect(flow.doneToday()).toMatchObject({
      businessDate: '2026-10-02',
      kind: 'FOREMAN_PROXY',
    });
  });
});

import { describe, expect, it } from 'vitest';
import type {
  CaptureFixDto,
  CheckInResultDto,
  ProxyCheckInCommand,
} from '@mje/contracts';
import { parseProxyCheckInCommand } from '@mje/contracts';
import { FieldApiError } from './field-api.js';
import { ProxyFlow } from './proxy-flow.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
function harness(start = Date.parse('2026-10-02T08:00:00.000Z')) {
  let clock = start;
  let keys = 0;
  let locates = 0;
  let accuracy = '20.00';
  const sent: {
    key: string;
    body: ProxyCheckInCommand;
    settle: (v: unknown) => void;
  }[] = [];
  const ended: string[] = [];
  const m = new Map<string, string>();
  const flow = new ProxyFlow({
    api: {
      proxyCheckIn: (key: string, build: () => ProxyCheckInCommand) =>
        new Promise<CheckInResultDto>((resolve, reject) =>
          sent.push({
            key,
            body: build(),
            settle: (v) =>
              v instanceof Error ? reject(v) : resolve(v as CheckInResultDto),
          }),
        ),
    },
    deviceId: 'fd',
    timeZone: 'Europe/Belgrade',
    storage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    } as Storage,
    locate: async () => {
      locates++;
      // TEST coordinates only.
      const fix: CaptureFixDto = {
        lat: '1.000000',
        lon: '1.000000',
        accuracyM: accuracy,
        fixAt: new Date(clock).toISOString(),
      };
      return { fix, reason: null };
    },
    now: () => clock,
    newKey: () =>
      `${String(++keys).padStart(8, '0')}-0000-4000-8000-000000000000`,
    onEnded: (c) => ended.push(c),
    notify: () => {},
  });
  return {
    flow,
    sent,
    ended,
    locates: () => locates,
    setClock: (t: number) => (clock = t),
    setAccuracy: (a: string) => (accuracy = a),
  };
}
const ok = (over: Partial<CheckInResultDto> = {}): CheckInResultDto => ({
  checkInId: 'c',
  businessDate: '2026-10-02',
  kind: 'FOREMAN_PROXY',
  occurredAt: '2026-10-02T08:00:00.000Z',
  timePrecision: 'EXACT',
  flags: [],
  hasSelfie: false,
  afterSubmission: false,
  ...over,
});

describe('foreman crew check-in (ProxyFlow)', () => {
  it("sends the member with the foreman's own fix, reuses a fresh fix for the next member", async () => {
    const h = harness();
    const a = h.flow.checkIn(W1, 'TEST');
    await tick();
    expect(h.sent[0]!.body.personId).toBe(W1);
    expect(parseProxyCheckInCommand(h.sent[0]!.body)).toEqual(h.sent[0]!.body);
    h.sent[0]!.settle(ok());
    await a;
    expect(h.flow.doneFor(W1)?.kind).toBe('FOREMAN_PROXY');
    h.setClock(Date.parse('2026-10-02T08:01:00.000Z'));
    const b = h.flow.checkIn(W2, 'TEST');
    await tick();
    expect(h.locates()).toBe(1);
    h.sent[1]!.settle(ok());
    await b;
    // Past 90 s the phone locates again (T1 allows at most 2 minutes).
    h.setClock(Date.parse('2026-10-02T08:02:00.000Z'));
    void h.flow.checkIn('33333333-3333-4333-8333-333333333333', 'TEST');
    await tick();
    expect(h.locates()).toBe(2);
  });
  it('one member at a time: an unresolved check-in is resent unchanged before anyone else', async () => {
    const h = harness();
    const a = h.flow.checkIn(W1, 'TEST');
    await tick();
    h.sent[0]!.settle(new FieldApiError('NETWORK', 0));
    await a;
    expect(h.flow.phase.kind).toBe('unsettled');
    expect(h.flow.canStart(W2)).toBe(false);
    await h.flow.checkIn(W2, 'TEST');
    expect(h.sent).toHaveLength(1);
    h.setClock(Date.parse('2026-10-02T08:10:00.000Z'));
    const r = h.flow.retry();
    await tick();
    expect(h.sent[1]!.key).toBe(h.sent[0]!.key);
    expect({ ...h.sent[1]!.body, deviceSentAt: null }).toEqual({
      ...h.sent[0]!.body,
      deviceSentAt: null,
    });
    expect(h.sent[1]!.body.deviceSentAt).toBe('2026-10-02T08:10:00.000Z');
    h.sent[1]!.settle(ok());
    await r;
    expect(h.flow.canStart(W2)).toBe(true);
  });
  it('a coarse fix is not sent; a fence refusal drops the cached fix', async () => {
    const h = harness();
    h.setAccuracy('150.00');
    await h.flow.checkIn(W1, 'TEST');
    expect(h.flow.phase).toEqual({ kind: 'coarse', accuracyM: '150.00' });
    expect(h.sent).toHaveLength(0);
    h.setAccuracy('20.00');
    const a = h.flow.checkIn(W1, 'TEST');
    await tick();
    h.sent[0]!.settle(new FieldApiError('GEOFENCE_OUTSIDE', 409));
    await a;
    expect(h.flow.phase).toEqual({ kind: 'refused', code: 'GEOFENCE_OUTSIDE' });
    const before = h.locates();
    void h.flow.checkIn(W1, 'TEST');
    await tick();
    expect(h.locates()).toBe(before + 1);
  });
  it('ALREADY_CHECKED_IN shows the existing check-in; an ended device reaches the page', async () => {
    const h = harness();
    const a = h.flow.checkIn(W1, 'TEST');
    await tick();
    h.sent[0]!.settle(
      new FieldApiError('ALREADY_CHECKED_IN', 409, {
        occurredAt: '2026-10-02T06:00:00.000Z',
        kind: 'SELF',
      }),
    );
    await a;
    expect(h.flow.doneFor(W1)).toEqual({
      occurredAt: '2026-10-02T06:00:00.000Z',
      kind: 'SELF',
      flags: [],
    });
    const b = h.flow.checkIn(W2, 'TEST');
    await tick();
    h.sent[1]!.settle(new FieldApiError('DEVICE_ENDED', 401));
    await b;
    expect(h.ended).toEqual(['DEVICE_ENDED']);
  });
  it("forgets yesterday's results after the site's midnight", async () => {
    const h = harness(Date.parse('2026-10-02T21:50:00.000Z'));
    const a = h.flow.checkIn(W1, 'TEST');
    await tick();
    h.sent[0]!.settle(ok());
    await a;
    expect(h.flow.doneFor(W1)).not.toBeNull();
    h.setClock(Date.parse('2026-10-02T22:05:00.000Z'));
    expect(h.flow.doneFor(W1)).toBeNull();
    expect(h.flow.canStart(W1)).toBe(true);
  });
});

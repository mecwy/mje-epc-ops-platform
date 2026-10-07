import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWeatherRuntime } from './weather-runtime.js';
const org = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.useRealTimers());
describe('Dev embedded consumer lifecycle', () => {
  it('import/construction/default-off starts no work and cannot consume queued requests', async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn(async () => {});
    const r = createWeatherRuntime({ runOnce });
    r.start();
    r.wake();
    await vi.advanceTimersByTimeAsync(60000);
    await r.stop();
    expect(runOnce).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { deploymentEnvironment: 'production', businessOrgId: org },
    { deploymentEnvironment: 'dev' },
    { deploymentEnvironment: 'dev', businessOrgId: 'TEST tenant/client org' },
  ])('requires Dev and trusted business-org config %#', (config) => {
    expect(() =>
      createWeatherRuntime({
        enabled: true,
        ...config,
        runOnce: async () => {},
      }),
    ).toThrow('WEATHER_DEV_CONFIGURATION_REQUIRED');
  });
  it('automatically retries after fail delay, and scans past a cleanup-null head without user interaction', async () => {
    vi.useFakeTimers();
    let nextAttempt = 0,
      attempts = 0,
      rounds = 0,
      finished = 0;
    const r = createWeatherRuntime({
      enabled: true,
      deploymentEnvironment: 'dev',
      businessOrgId: org,
      runOnce: async () => {
        rounds++;
        if (rounds === 1) return; // domain exhausted-head cleanup also returns null
        if (Date.now() < nextAttempt) return;
        attempts++;
        if (attempts === 1) {
          nextAttempt = Date.now() + 5000;
          return;
        }
        finished++;
      },
    });
    r.start();
    await vi.advanceTimersByTimeAsync(8000);
    expect(rounds).toBe(5);
    expect(attempts).toBe(2);
    expect(finished).toBe(1);
    await r.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces busy wakes and never overlaps rounds', async () => {
    vi.useFakeTimers();
    let resolve!: () => void,
      count = 0,
      inFlight = 0,
      max = 0;
    const r = createWeatherRuntime({
      enabled: true,
      deploymentEnvironment: 'dev',
      businessOrgId: org,
      runOnce: async () => {
        count++;
        max = Math.max(max, ++inFlight);
        if (count === 1)
          await new Promise<void>((r) => {
            resolve = r;
          });
        inFlight--;
      },
    });
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 100; i++) r.wake();
    await vi.advanceTimersByTimeAsync(10000);
    expect(count).toBe(1);
    resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(count).toBe(2);
    expect(max).toBe(1);
    await r.stop();
  });
  it('stop aborts and joins provider/finish cleanup before the caller closes its pool', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let finish!: () => void;
    const r = createWeatherRuntime({
      enabled: true,
      deploymentEnvironment: 'dev',
      businessOrgId: org,
      runOnce: async (_, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              events.push('abort');
              finish = resolve;
            },
            { once: true },
          );
        });
        events.push('settled');
      },
    });
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = r.stop();
    expect(r.stop()).toBe(stopped);
    expect(events).toEqual(['abort']);
    finish();
    await stopped;
    events.push('pool-close');
    r.wake();
    r.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(events).toEqual(['abort', 'settled', 'pool-close']);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('repeats after safe bounded claim errors without leaking raw error or rescheduling after stop', async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn(async () => {
      throw new Error('TEST private database URI');
    });
    const r = createWeatherRuntime({
      enabled: true,
      deploymentEnvironment: 'dev',
      businessOrgId: org,
      runOnce,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(12000);
    expect(runOnce).toHaveBeenCalledTimes(3);
    await r.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(runOnce).toHaveBeenCalledTimes(3);
  });
});

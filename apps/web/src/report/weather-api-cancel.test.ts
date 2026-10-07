import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportApi } from '../api.js';
import type { WeatherRequestCommand } from '@mje/contracts';

const command: WeatherRequestCommand = {
  projectId: 'TEST-project',
  businessDate: '2026-10-08',
  locationVersionId: 'TEST-location',
  refresh: false,
  clientMutationId: 'TEST-key',
};
type WeatherApi = ReturnType<typeof reportApi>;
const calls: Array<
  [string, (api: WeatherApi, signal: AbortSignal) => Promise<unknown>]
> = [
  ['locations', (api, signal) => api.weatherLocations('TEST-project', signal)],
  ['request', (api, signal) => api.requestWeather(command, signal)],
  [
    'status',
    (api, signal) =>
      api.weatherRequestStatus('TEST-project', 'TEST-request', signal),
  ],
  [
    'snapshot',
    (api, signal) =>
      api.weatherSnapshot('TEST-project', 'TEST-snapshot', signal),
  ],
];
const drain = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const caught = (operation: Promise<unknown>) =>
  operation.catch((error: unknown) => error);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('weather API cancellation', () => {
  it.each(calls)(
    '%s refuses an already aborted signal before token acquisition',
    async (_name, call) => {
      const token = vi.fn(async () => 'TEST-token');
      const fetch = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', fetch);
      const controller = new AbortController();
      controller.abort();
      await expect(
        call(reportApi(token), controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(token).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(calls)(
    '%s cancels a pending token and never fetches after the token arrives',
    async (_name, call) => {
      let resolve!: (value: string) => void;
      const token = () =>
        new Promise<string>((done) => {
          resolve = done;
        });
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const controller = new AbortController();
      const result = caught(call(reportApi(token), controller.signal));
      controller.abort();
      await expect(result).resolves.toMatchObject({ name: 'AbortError' });
      resolve('TEST-token');
      await drain();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(calls)(
    '%s forwards the signal and ignores a late fetch response without retry',
    async (_name, call) => {
      let resolve!: (value: Response) => void;
      const fetch = vi.fn((_url: string, _init: RequestInit) => {
        void _url;
        void _init;
        return new Promise<Response>((done) => {
          resolve = done;
        });
      });
      vi.stubGlobal('fetch', fetch);
      const retry = vi.fn();
      const controller = new AbortController();
      const result = caught(
        call(
          reportApi(async () => 'TEST-token', retry),
          controller.signal,
        ),
      );
      await drain();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1].signal).toBe(controller.signal);
      controller.abort();
      await expect(result).resolves.toMatchObject({ name: 'AbortError' });
      resolve(new Response('{}'));
      await drain();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    },
  );
  it.each(calls)(
    '%s cancels network retry delay without a second request',
    async (_name, call) => {
      vi.useFakeTimers();
      const fetch = vi.fn(async () => {
        throw new Error('TEST lost response');
      });
      vi.stubGlobal('fetch', fetch);
      const retry = vi.fn();
      const controller = new AbortController();
      const result = caught(
        call(
          reportApi(async () => 'TEST-token', retry),
          controller.signal,
        ),
      );
      await drain();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      await expect(result).resolves.toMatchObject({ name: 'AbortError' });
      await vi.runAllTimersAsync();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each([true, false])(
    'cancels pending response body (success=%s)',
    async (ok) => {
      let resolve!: (value: unknown) => void;
      const body = vi.fn(
        () =>
          new Promise<unknown>((done) => {
            resolve = done;
          }),
      );
      const fetch = vi.fn(async () => ({
        ok,
        status: ok ? 200 : 503,
        json: body,
        text: body,
      }));
      vi.stubGlobal('fetch', fetch);
      const controller = new AbortController();
      const result = caught(
        reportApi(async () => 'TEST-token').weatherLocations(
          'TEST-project',
          controller.signal,
        ),
      );
      await drain();
      expect(body).toHaveBeenCalledTimes(1);
      controller.abort();
      await expect(result).resolves.toMatchObject({ name: 'AbortError' });
      resolve(ok ? [] : '{}');
      await drain();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps the same weather mutation key through ordinary network retry', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = vi.fn(async () => {
      if (attempts++ === 0) throw new Error('TEST lost response');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetch);
    const retry = vi.fn();
    const result = reportApi(async () => 'TEST-token', retry).requestWeather(
      command,
    );
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledTimes(1);
    const first = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const second = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(second[1]).toEqual(first[1]);
    expect(
      (second[1].headers as Record<string, string>)['Idempotency-Key'],
    ).toBe('TEST-key');
    expect(second[1]).not.toHaveProperty('signal');
  });
  it('preserves existing non-weather retry without a signal', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = vi.fn(async () => {
      if (attempts++ === 0) throw new DOMException('TEST', 'AbortError');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetch);
    const result = reportApi(async () => 'TEST-token').projectStatus(
      'TEST-project',
    );
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

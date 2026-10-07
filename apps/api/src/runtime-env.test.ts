import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createApp } from './app.js';
import {
  applicationResourceLifecycle,
  ConfigError,
  weatherConsumerConfig,
  weatherRuntimeFromEnv,
} from './runtime-env.js';

const dev = {
  NODE_ENV: 'production',
  ALPHA_ENABLED: 'true',
  WEATHER_REFERENCE_ENABLED: 'true',
  MJE_DEPLOYMENT_ENV: 'dev',
  WEATHER_WORKER_ORG_ID: '11111111-1111-4111-8111-111111111111',
  WEATHER_MET_USER_AGENT:
    'TEST weather-consumer https://example.invalid/contact',
};

describe('explicit Dev weather boot', () => {
  it.each([undefined, 'false', 'TRUE', '1'])(
    'is off without exact opt-in %s',
    (flag) => {
      expect(
        weatherConsumerConfig({ WEATHER_REFERENCE_ENABLED: flag }),
      ).toBeUndefined();
      const pool = { connect: vi.fn(), query: vi.fn() };
      expect(
        weatherRuntimeFromEnv(pool as unknown as Pool, {
          WEATHER_REFERENCE_ENABLED: flag,
        }),
      ).toBeUndefined();
      expect(pool.connect).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
    },
  );
  it('uses an explicit Dev environment even in the production Node image', () => {
    expect(weatherConsumerConfig(dev)).toEqual({
      orgId: dev.WEATHER_WORKER_ORG_ID,
      userAgent: dev.WEATHER_MET_USER_AGENT,
    });
  });
  it.each([undefined, 'uat', 'prod', 'production', 'DEV'])(
    'refuses other deployment %s',
    (environment) => {
      expect(() =>
        weatherConsumerConfig({ ...dev, MJE_DEPLOYMENT_ENV: environment }),
      ).toThrow('WEATHER_DEV_CONFIGURATION_REQUIRED');
    },
  );
  it('cannot opt in without the authenticated API', () => {
    expect(() =>
      weatherConsumerConfig({ ...dev, ALPHA_ENABLED: 'false' }),
    ).toThrow('WEATHER_DEV_CONFIGURATION_REQUIRED');
  });
  it.each([undefined, '', 'not-an-org'])(
    'never falls back to an Entra tenant %s',
    (org) => {
      expect(() =>
        weatherConsumerConfig({
          ...dev,
          WEATHER_WORKER_ORG_ID: org,
          ENTRA_TENANT_ID: dev.WEATHER_WORKER_ORG_ID,
        }),
      ).toThrow('WEATHER_WORKER_ORG_ID');
    },
  );
  it.each([
    undefined,
    '',
    'generic',
    'agent\r\nTEST@example.invalid',
    'x'.repeat(301),
  ])('requires a bounded identifying contact', (agent) => {
    let caught: unknown;
    try {
      weatherConsumerConfig({ ...dev, WEATHER_MET_USER_AGENT: agent });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(String(caught)).toBe(
      'ConfigError: MISSING_CONFIGURATION: WEATHER_MET_USER_AGENT',
    );
  });
});

describe('single resource shutdown lifecycle', () => {
  it('Nest invokes the resource hooks with Alpha absent and releases them on close', async () => {
    const events: string[] = [];
    const resources = applicationResourceLifecycle({
      weather: {
        stop: async () => {
          events.push('weather-joined');
        },
      },
      closePool: async () => {
        events.push('pool');
      },
    });
    const app = await createApp(undefined, {
      resourceLifecycle: resources,
      installSignalHandlers: false,
    });
    await app.init();
    await app.close();
    expect(events).toEqual(['weather-joined', 'pool']);
  });
  it('joins the consumer before HTTP drain and closes the pool once after it', async () => {
    const sequence: string[] = [];
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = applicationResourceLifecycle({
      weather: {
        stop: vi.fn(async () => {
          sequence.push('stop');
          await stopped;
          sequence.push('joined');
        }),
      },
      closePool: async () => {
        sequence.push('pool');
      },
    });
    const before = lifecycle.beforeApplicationShutdown();
    expect(lifecycle.beforeApplicationShutdown()).toBe(before);
    await Promise.resolve();
    expect(sequence).toEqual(['stop']);
    release();
    await before;
    sequence.push('http-drained');
    const after = lifecycle.onApplicationShutdown();
    expect(lifecycle.onApplicationShutdown()).toBe(after);
    await after;
    expect(sequence).toEqual(['stop', 'joined', 'http-drained', 'pool']);
  });
  it('also owns pool closure when weather is disabled', async () => {
    const closePool = vi.fn(async () => undefined);
    const lifecycle = applicationResourceLifecycle({ closePool });
    await lifecycle.beforeApplicationShutdown();
    await lifecycle.onApplicationShutdown();
    await lifecycle.onApplicationShutdown();
    expect(closePool).toHaveBeenCalledTimes(1);
  });
});

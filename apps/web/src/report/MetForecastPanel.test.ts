import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translate, type Lang } from '@mje/ui';
import {
  WEATHER_METRICS,
  type MetForecastDto,
  type SafeFrozenWeatherReference,
  type WeatherValueDto,
} from '@mje/contracts';
import { MetForecastPanel } from './MetForecastPanel.js';
import { FrozenWeatherReferences, WeatherLocation } from './WeatherLocation.js';
import { WeatherLocationSession } from './weather-location-session.js';
import { weatherReferenceView } from './weather-adapter.js';

let language: Lang = 'en';
vi.mock('../i18n.js', () => ({
  useI18n: () => ({
    t: (key: Parameters<typeof translate>[1]) => translate(language, key),
  }),
}));
const number = (value: string, unit: string): WeatherValueDto => ({
  state: 'value',
  value,
  raw: value,
  unit,
});
const missing: WeatherValueDto = {
  state: 'missing',
  raw: null,
  unit: null,
  reason: 'TEST missing',
};
function forecast(): MetForecastDto {
  return {
    providerUpdatedAt: '2026-10-07T07:00:00Z',
    outboundPoint: { lat: '45', lon: '19' },
    returnedPoint: { lat: '45', lon: '19' },
    coveredInterval: {
      startAt: '2026-10-07T08:00:00Z',
      endAt: '2026-10-07T20:00:00Z',
    },
    instants: [
      {
        at: '2026-10-07T08:00:00Z',
        airTemperature: number('0', 'celsius'),
        windSpeed: number('1.250000', 'm/s'),
        gust: missing,
      },
    ],
    periods: ([1, 6, 12] as const).map((hours) => ({
      startAt: '2026-10-07T08:00:00Z',
      endAt: `2026-10-07T${String(8 + hours).padStart(2, '0')}:00:00Z`,
      hours,
      symbolCode: 'rainshowers_day',
      precipitation: number(String(hours), 'mm'),
    })),
  };
}
function frozen(): SafeFrozenWeatherReference {
  return {
    referenceId: 'TEST-reference',
    snapshotId: 'TEST-snapshot',
    locationVersionId: 'TEST-location',
    adoptedAt: '2026-10-07T10:00:00Z',
    adoptedByAccountId: 'TEST-account',
    adoptedByPersonId: 'TEST-person',
    adapterVersion: 'TEST-met-v1',
    responseHash: 'TEST-hash',
    sourceLink:
      'https://api.met.no/weatherapi/locationforecast/2.0/documentation',
    licenseLink: 'https://creativecommons.org/licenses/by/4.0/',
    snapshot: {
      provider: 'met-norway',
      category: 'forecast',
      fetchedAt: '2026-10-07T09:00:00Z',
      publishedAt: null,
      coverage: 'partial',
      grid: null,
      query: {
        projectId: 'TEST-project',
        businessDate: '2026-10-07',
        locationVersionId: 'TEST-location',
        timezone: 'Europe/Belgrade',
        point: { lat: '45', lon: '19' },
        interval: {
          startAt: '2026-10-06T22:00:00Z',
          endAt: '2026-10-07T22:00:00Z',
        },
        product: 'forecast',
        model: 'forecast',
      },
      forecast: forecast(),
      metrics: Object.fromEntries(
        WEATHER_METRICS.map((key) => [
          key,
          {
            state: 'not_applicable',
            raw: null,
            unit: null,
            reason: 'TEST not daily',
          },
        ]),
      ) as SafeFrozenWeatherReference['snapshot']['metrics'],
    },
  };
}
function panel(f = forecast()) {
  return renderToStaticMarkup(
    createElement(MetForecastPanel, {
      forecast: f,
      fetchedAt: '2026-10-07T09:00:00Z',
    }),
  );
}

describe('MET forecast presentation', () => {
  beforeEach(() => {
    language = 'en';
  });
  it('keeps UTC instants, overlapping 1/6/12-hour periods and original units without summing', () => {
    const f = forecast(),
      before = structuredClone(f),
      html = panel(f);
    for (const text of [
      '2026-10-07T08:00:00Z',
      '2026-10-07T09:00:00Z',
      '2026-10-07T14:00:00Z',
      '2026-10-07T20:00:00Z',
      'UTC',
      '0 celsius',
      '1.250000 m/s',
      '1 h',
      '6 h',
      '12 h',
      'rainshowers_day',
      '1 mm',
      '6 mm',
      '12 mm',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('19 mm');
    expect(html).not.toContain('mean');
    expect(f).toEqual(before);
  });
  it('separates provider update from retrieval and includes supplier attribution in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      language = lang;
      const html = panel();
      expect(html).toContain(lang === 'en' ? 'Provider updated' : '供应商更新');
      expect(html).toContain('2026-10-07T07:00:00Z');
      expect(html).toContain('2026-10-07T09:00:00Z');
      expect(html).toContain('MET Norway');
      expect(html).toContain('CC BY 4.0');
      expect(html).toContain('https://creativecommons.org/licenses/by/4.0/');
    }
  });
  it('escapes displayed raw units/symbols and omits empty optional sections', () => {
    const f = forecast();
    f.periods[0]!.symbolCode = '<img src=x>';
    f.instants[0]!.windSpeed = number('1', '<unit>');
    const html = panel(f);
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('&lt;unit&gt;');
    expect(html).not.toContain('<img');
    f.periods = [];
    expect(panel(f)).not.toContain('Rain periods');
  });
  it('renders MET frozen data through the report component without empty daily metric prompts', () => {
    const reference = frozen(),
      before = structuredClone(reference);
    const html = renderToStaticMarkup(
      createElement(FrozenWeatherReferences, { references: [reference] }),
    );
    expect(html).toContain('rainshowers_day');
    expect(html).toContain('1.250000 m/s');
    expect(html).not.toContain('temperatureMax');
    expect(html).not.toContain('Published');
    expect(reference).toEqual(before);
  });
  it('keeps old Open-Meteo history readable and does not attach a MET panel to it', () => {
    const reference = frozen();
    const { forecast: originalForecast, ...old } = reference.snapshot;
    expect(originalForecast).toEqual(forecast());
    reference.snapshot = {
      ...old,
      provider: 'open-meteo',
      category: 'reanalysis',
      metrics: { ...old.metrics, precipitation: number('0', 'mm') },
    };
    const html = renderToStaticMarkup(
      createElement(FrozenWeatherReferences, { references: [reference] }),
    );
    expect(html).toContain('open-meteo');
    expect(html).toContain('0 mm');
    expect(html).not.toContain('rainshowers_day');
    expect(html).not.toContain('MET Norway');
  });
  it('connects the current session forecast and retains editable manual weather inputs without GPS capture', async () => {
    const reference = frozen(),
      view = weatherReferenceView(reference),
      locate = vi.fn();
    const session = new WeatherLocationSession(
      {
        ownerKey: 'TEST-owner',
        projectId: view.projectId,
        businessDate: view.businessDate,
        timezone: view.timezone,
        locationVersionId: view.locationVersionId,
      },
      {
        loadWeather: async () => view,
        locate,
        acceptLocation: () => {
          throw new Error('TEST no capture');
        },
        confirmLocation: () => false,
        referenceWeather: () => false,
      },
      { writable: true, locked: false },
    );
    expect(await session.refreshWeather()).toBe(true);
    const manual = vi.fn();
    const html = renderToStaticMarkup(
      createElement(WeatherLocation, {
        session,
        manualWeather: 'TEST observed rain',
        manualTemperature: '0',
        onManualChange: manual,
      }),
    );
    expect(html).toContain('rainshowers_day');
    expect(html).toContain('value="TEST observed rain"');
    expect(html).toContain('value="0"');
    expect(html).not.toContain('temperatureMax');
    expect(locate).not.toHaveBeenCalled();
    expect(manual).not.toHaveBeenCalled();
    session.deactivate();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { WeatherStoreError, ReportError } from '@mje/domain';
import { InvalidReportInput } from '@mje/contracts';
import { SafeErrorFilter } from './app.js';
function response(error: unknown) {
  const send = vi.fn();
  const status = vi.fn((value: number) => ({ statusCode: value, json: send }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  new SafeErrorFilter().catch(error, host);
  return { status: status.mock.calls[0]?.[0], body: send.mock.calls[0]?.[0] };
}
describe('weather error envelope', () => {
  it('maps helper failure to outcome-unknown response with no coordinates or underlying details', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = response(
        Object.assign(new WeatherStoreError('WEATHER_STORE_FAILED'), {
          detail: 'TEST-private lat=44.123456789012',
        }),
      );
      expect(result.status).toBe(500);
      expect(result.body).toMatchObject({
        code: 'REQUEST_FAILED',
        correlationId: expect.any(String),
      });
      expect(Object.keys(result.body)).toEqual(['code', 'correlationId']);
      expect(JSON.stringify(result.body)).not.toContain('TEST-private');
      expect(JSON.stringify(log.mock.calls)).not.toContain('44.123456789012');
    } finally {
      log.mockRestore();
    }
  });
  it('keeps deterministic invalid-input and read-only refusals distinct', () => {
    expect(
      response(new InvalidReportInput('weather.locationRef')),
    ).toMatchObject({ status: 400, body: { code: 'INVALID_INPUT' } });
    expect(response(new ReportError('READ_ONLY'))).toMatchObject({
      status: 403,
      body: { code: 'READ_ONLY' },
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { InvalidReportInput } from '@mje/contracts';
import { ManagerReviewError, ReportError } from '@mje/domain';
import { SafeErrorFilter } from './app.js';
import { ManagerReviewHttpErrors } from './manager-review.controller.js';
function response(error: unknown, filter = new ManagerReviewHttpErrors()) {
  const send = vi.fn();
  const status = vi.fn((value: number) => ({ statusCode: value, json: send }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  filter.catch(error, host);
  return { status: status.mock.calls[0]?.[0], body: send.mock.calls[0]?.[0] };
}
describe('C04 safe review HTTP error boundary', () => {
  it.each([
    ['SELF_REVIEW', 403],
    ['READ_ONLY', 403],
    ['REVIEW_AUTHORITY_UNKNOWN', 403],
    ['FOREMAN_REVISION_CHANGED', 409],
    ['EVIDENCE_CHANGED', 409],
    ['NOT_FOUND', 404],
  ] as const)('maps %s without disclosing private details', (code, status) => {
    const result = response(
      Object.assign(new ManagerReviewError(code), {
        detail: 'TEST_personal_point',
        confirmedQty: '99',
      }),
    );
    expect(result.status).toBe(status);
    expect(result.body).toEqual({
      code,
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(result.body)).not.toContain('TEST_personal_point');
    expect(JSON.stringify(result.body)).not.toContain('confirmedQty');
  });
  it('keeps authentication, strict invalid input and retry failures distinct', () => {
    expect(response(new UnauthorizedException('private token'))).toMatchObject({
      status: 401,
      body: { code: 'LOGIN_REQUIRED' },
    });
    expect(response(new InvalidReportInput('private raw field'))).toMatchObject(
      { status: 400, body: { code: 'INVALID_INPUT' } },
    );
    expect(response({ code: '40001', detail: 'private SQL' })).toMatchObject({
      status: 503,
      body: { code: 'RETRY' },
    });
  });
  it('collapses unexpected SQL and arbitrary error codes into a fixed envelope', () => {
    const result = response({
      code: '23503',
      message: 'TEST_private SQL',
      detail: 'TEST_personal_point',
    });
    expect(result).toMatchObject({
      status: 500,
      body: { code: 'REQUEST_FAILED' },
    });
    expect(Object.keys(result.body)).toEqual(['code', 'correlationId']);
    expect(JSON.stringify(result.body)).not.toContain('TEST_');
  });
});

describe('shared report feature refusal envelope', () => {
  it('returns fixed FEATURE_DISABLED for disabled weather capture without exposing coordinates', () => {
    const result = response(
      Object.assign(new ReportError('FEATURE_DISABLED'), {
        detail: 'TEST_personal_point',
      }),
      new SafeErrorFilter(),
    );
    expect(result).toMatchObject({
      status: 403,
      body: { code: 'FEATURE_DISABLED' },
    });
    expect(Object.keys(result.body)).toEqual(['code', 'correlationId']);
    expect(JSON.stringify(result.body)).not.toContain('TEST_personal_point');
  });
});

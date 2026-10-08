import {
  Body,
  Catch,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { RETRY_SQLSTATES } from '@mje/domain';
import type { BusinessEvidenceService } from '@mje/contracts';
import {
  InvalidReportInput,
  parseBusinessEvidenceCommand,
  parseBusinessEvidenceQuery,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';

export const BUSINESS_EVIDENCE_SERVICE = Symbol('BUSINESS_EVIDENCE_SERVICE');
/** Fixed envelope only; raw source, SQL, media and credential errors remain private. */
const EVIDENCE_STATUS: Readonly<Record<string, number>> = {
  FORBIDDEN: 403,
  READ_ONLY: 403,
  NOT_FOUND: 404,
  ITEM_NOT_FOUND: 404,
  SOURCE_UNAVAILABLE: 503,
  INTEGRATION_REQUIRED: 503,
  LOCKED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  LINK_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  TARGET_CHANGED: 409,
  COVERAGE_INVALID: 400,
  PHOTO_NOT_AVAILABLE: 409,
  EVIDENCE_CHANGED: 409,
  QUANTITY_UNKNOWN: 409,
  COVERAGE_CONFLICT: 409,
  INVALID_IDENTITY: 403,
  UNIT_MISMATCH: 409,
  SCOPE_UNCONFIRMED: 409,
};
/** Use the existing C04 controller-filter pattern; the shared filter normalizes HttpException. */
@Catch()
export class BusinessEvidenceHttpErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const raw =
      error && typeof error === 'object' && 'code' in error ? error.code : null;
    const code =
      error instanceof UnauthorizedException
        ? 'LOGIN_REQUIRED'
        : error instanceof InvalidReportInput
          ? 'INVALID_INPUT'
          : typeof raw === 'string' && RETRY_SQLSTATES.includes(raw)
            ? 'RETRY'
            : typeof raw === 'string' && Object.hasOwn(EVIDENCE_STATUS, raw)
              ? raw
              : 'REQUEST_FAILED';
    const status =
      code === 'LOGIN_REQUIRED'
        ? 401
        : code === 'INVALID_INPUT'
          ? 400
          : code === 'RETRY'
            ? 503
            : (EVIDENCE_STATUS[code] ?? 500);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ code, correlationId: randomUUID() });
  }
}
/** Parent registers an actual service and its error mapping. No default service or login bypass. */
@Controller('api/report/business-evidence')
@UseFilters(BusinessEvidenceHttpErrors)
export class BusinessEvidenceController {
  constructor(
    @Inject(BUSINESS_EVIDENCE_SERVICE)
    private readonly service: BusinessEvidenceService,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(request: Request) {
    try {
      return await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  @Get()
  async read(@Req() request: Request, @Query() query: unknown) {
    const identity = await this.identity(request);
    return this.service.read(identity, parseBusinessEvidenceQuery(query));
  }
  @Post()
  @HttpCode(200)
  async write(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    const command = parseBusinessEvidenceCommand(body);
    if (
      typeof key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        key,
      ) ||
      key.toLowerCase() !== command.clientMutationId
    )
      throw new InvalidReportInput('Idempotency-Key');
    return this.service.write(identity, command);
  }
}

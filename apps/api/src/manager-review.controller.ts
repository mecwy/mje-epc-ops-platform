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
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { RETRY_SQLSTATES } from '@mje/domain';
import {
  InvalidReportInput,
  parseReviewForemanCommand,
  parseManagerReviewScope,
  type ReviewForemanCommand,
} from '@mje/contracts';
import type {
  ManagerReviewReadDto,
  ManagerReviewScopeDto,
  ManagerReviewWriteResultDto,
} from '@mje/contracts';
import { TokenVerifier, type VerifiedIdentity } from './auth/token-verifier.js';

export const MANAGER_REVIEW_SERVICE = Symbol('MANAGER_REVIEW_SERVICE');
export interface ManagerReviewService {
  read(
    identity: VerifiedIdentity,
    scope: ManagerReviewScopeDto,
  ): Promise<ManagerReviewReadDto>;
  write(
    identity: VerifiedIdentity,
    command: ReviewForemanCommand,
  ): Promise<ManagerReviewWriteResultDto>;
}
/** Fixed envelopes for this additive controller while the shared error registry is frozen. */
@Catch()
export class ManagerReviewHttpErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const statuses: Readonly<Record<string, number>> = {
      FORBIDDEN: 403,
      READ_ONLY: 403,
      IDENTITY_UNKNOWN: 403,
      REVIEW_AUTHORITY_UNKNOWN: 403,
      SELF_REVIEW: 403,
      REVIEW_CONFLICT: 403,
      INDEPENDENCE_UNKNOWN: 403,
      NOT_FOUND: 404,
      ITEM_NOT_FOUND: 404,
      LOCKED: 409,
      TARGET_CHANGED: 409,
      FOREMAN_REVISION_CHANGED: 409,
      REVIEW_VERSION_CONFLICT: 409,
      REVIEW_VERSION_EXHAUSTED: 409,
      EVIDENCE_CHANGED: 409,
      EVIDENCE_REQUIRED: 409,
      SCOPE_UNCONFIRMED: 409,
      QUANTITY_UNKNOWN: 409,
      UNIT_MISMATCH: 409,
      COVERAGE_INVALID: 409,
      REASON_REQUIRED: 400,
      METHOD_REQUIRED: 400,
      REVIEW_HISTORY_CONFLICT: 409,
      IDEMPOTENCY_KEY_REUSED: 409,
    };
    const raw =
      error && typeof error === 'object' && 'code' in error ? error.code : null;
    const code =
      error instanceof UnauthorizedException
        ? 'LOGIN_REQUIRED'
        : error instanceof InvalidReportInput
          ? 'INVALID_INPUT'
          : typeof raw === 'string' && RETRY_SQLSTATES.includes(raw)
            ? 'RETRY'
            : typeof raw === 'string' && Object.hasOwn(statuses, raw)
              ? raw
              : 'REQUEST_FAILED';
    const status =
      code === 'LOGIN_REQUIRED'
        ? 401
        : code === 'INVALID_INPUT'
          ? 400
          : code === 'RETRY'
            ? 503
            : (statuses[code] ?? 500);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ code, correlationId: randomUUID() });
  }
}
/** Optional service mounting requires the real report store and explicit server ports. */
@Controller('api/report/manager-review')
@UseFilters(ManagerReviewHttpErrors)
export class ManagerReviewController {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(MANAGER_REVIEW_SERVICE)
    private readonly service: ManagerReviewService,
  ) {}
  private async identity(request: Request): Promise<VerifiedIdentity> {
    try {
      return await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  @Get()
  async read(
    @Req() request: Request,
    @Query() query: unknown,
  ): Promise<ManagerReviewReadDto> {
    return this.service.read(
      await this.identity(request),
      parseManagerReviewScope(query),
    );
  }
  @Post()
  @HttpCode(200)
  async write(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ): Promise<ManagerReviewWriteResultDto> {
    const identity = await this.identity(request);
    const command = parseReviewForemanCommand(body);
    if (
      typeof key !== 'string' ||
      key.toLowerCase() !== command.clientMutationId
    )
      throw new InvalidReportInput('Idempotency-Key');
    return this.service.write(identity, command);
  }
}

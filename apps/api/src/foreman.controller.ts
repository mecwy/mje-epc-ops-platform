import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ForemanStore, ReportStore } from '@mje/domain';
import {
  InvalidReportInput,
  parseForemanAdoptCommand,
  parseForemanReportCommand,
  parseForemanReportQuery,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';
import { FieldTokenGuard } from './field.controller.js';

type FieldRequest = Request & { fieldTokenHash?: string };
const clientIp = (request: Request) => request.ip ?? 'unknown';
function keyed<T extends { clientMutationId: string }>(
  parse: (body: unknown) => T,
  body: unknown,
  key: unknown,
): T {
  const command = parse(body);
  if (key !== command.clientMutationId)
    throw new InvalidReportInput('Idempotency-Key');
  return command;
}

/**
 * Foreman quantity reports (A6c): a CONFIRMED foreman device, its own current crew, the site's
 * today or yesterday. Bodies carry no projectId: the project is the device's.
 */
@Controller('api/field')
@UseGuards(FieldTokenGuard)
export class ForemanFieldController {
  constructor(@Inject(ForemanStore) private readonly store: ForemanStore) {}

  @Get('report')
  report(
    @Req() request: FieldRequest,
    @Query('businessDate') businessDate: unknown,
  ) {
    return this.store.report(
      clientIp(request),
      request.fieldTokenHash!,
      parseForemanReportQuery({ businessDate }).businessDate,
    );
  }
  @Post('report')
  @HttpCode(200)
  submit(
    @Req() request: FieldRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.store.submitReport(
      clientIp(request),
      request.fieldTokenHash!,
      keyed(parseForemanReportCommand, body, key),
    );
  }
}

/** The PM's explicit adoption of a COMPLETE foreman total (Entra PROJECT_MANAGER). */
@Controller('api/report/foreman')
export class ForemanAdoptController {
  constructor(
    @Inject(ReportStore) private readonly store: ReportStore,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  @Post('adopt')
  @HttpCode(200)
  async adopt(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    let identity;
    try {
      identity = await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
    return this.store.adoptForeman(
      identity,
      keyed(parseForemanAdoptCommand, body, key),
    );
  }
}

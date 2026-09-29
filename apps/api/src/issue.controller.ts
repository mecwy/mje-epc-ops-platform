import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { IssueStore } from '@mje/domain';
import {
  InvalidReportInput,
  isRealDate,
  parseCloseIssueCommand,
  parseCreateIssueCommand,
  parseDismissLagCommand,
  parseNoteIssueCommand,
  parseReopenIssueCommand,
  parseReplyIssueCommand,
  parseSetEscalateCommand,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new InvalidReportInput(field);
  return value.toLowerCase();
}
function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isRealDate(value))
    throw new InvalidReportInput(field);
  return value;
}

/** Issues and escalation routes (U2.1 rule 10). Authorization, versions, idempotency and audit live in IssueStore. */
@Controller('api/report/issues')
export class IssueController {
  constructor(
    @Inject(IssueStore) private readonly store: IssueStore,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(request: Request) {
    try {
      return await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  private command<T extends { clientMutationId: string }>(
    parse: (body: unknown) => T,
    body: unknown,
    key: unknown,
  ): T {
    const command = parse(body);
    if (id(key, 'Idempotency-Key') !== command.clientMutationId)
      throw new InvalidReportInput('Idempotency-Key');
    return command;
  }

  @Get()
  async list(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('businessDate') businessDate: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.list(
      identity,
      id(projectId, 'projectId'),
      date(businessDate, 'businessDate'),
    );
  }
  // Declared before ':issueId' so that 'lag' is never read as an id.
  @Get('lag')
  async lag(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('businessDate') businessDate: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.lag(
      identity,
      id(projectId, 'projectId'),
      date(businessDate, 'businessDate'),
    );
  }
  @Get(':issueId')
  async one(@Req() request: Request, @Param('issueId') issueId: unknown) {
    const identity = await this.identity(request);
    return this.store.get(identity, id(issueId, 'issueId'));
  }

  @Post()
  @HttpCode(200)
  async create(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.create(
      identity,
      this.command(parseCreateIssueCommand, body, key),
    );
  }
  @Post('note')
  @HttpCode(200)
  async note(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.note(
      identity,
      this.command(parseNoteIssueCommand, body, key),
    );
  }
  @Post('escalate')
  @HttpCode(200)
  async escalate(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.setEscalate(
      identity,
      this.command(parseSetEscalateCommand, body, key),
    );
  }
  @Post('close')
  @HttpCode(200)
  async close(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.close(
      identity,
      this.command(parseCloseIssueCommand, body, key),
    );
  }
  @Post('reopen')
  @HttpCode(200)
  async reopen(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.reopen(
      identity,
      this.command(parseReopenIssueCommand, body, key),
    );
  }
  @Post('reply')
  @HttpCode(200)
  async reply(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.reply(
      identity,
      this.command(parseReplyIssueCommand, body, key),
    );
  }
  @Post('lag/dismiss')
  @HttpCode(200)
  async dismissLag(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.dismissLag(
      identity,
      this.command(parseDismissLagCommand, body, key),
    );
  }
}

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
} from '@nestjs/common';
import type { Request } from 'express';
import { ReportStore, reportReader } from '@mje/domain';
import {
  InvalidReportInput,
  parseCancelCorrectionCommand,
  parseConfirmPlanCommand,
  parseNoWorkCommand,
  parseSaveFactsCommand,
  parseSaveItemsCommand,
  parseSavePlanDraftCommand,
  parseStartCorrectionCommand,
  parseSubmitReportCommand,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new InvalidReportInput(field);
  return value.toLowerCase();
}
function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value))
    throw new InvalidReportInput(field);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    throw new InvalidReportInput(field);
  return value;
}

/** Site Daily Close routes. Authorization, versions, idempotency and audit live in ReportStore. */
@Controller('api/report')
export class ReportController {
  constructor(
    @Inject(ReportStore) private readonly store: ReportStore,
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

  /**
   * Every read goes through the report module exit (ADR-0003 D2): the store opens the read
   * transaction and the exit checks the project and applies the projection for the caller.
   * Input is validated before the transaction, as before.
   */
  @Get('projects')
  async projects(@Req() request: Request) {
    return this.store.read(await this.identity(request), (ctx) =>
      reportReader.forContext(ctx).projects(),
    );
  }
  @Get('days')
  async days(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
  ) {
    const identity = await this.identity(request);
    const project = id(projectId, 'projectId');
    const first = date(from, 'from');
    const last = date(to, 'to');
    return this.store.read(identity, (ctx) =>
      reportReader.forContext(ctx).days(project, first, last),
    );
  }
  @Get('day')
  async day(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('businessDate') businessDate: unknown,
  ) {
    const identity = await this.identity(request);
    const project = id(projectId, 'projectId');
    const day = date(businessDate, 'businessDate');
    return this.store.read(identity, (ctx) =>
      reportReader.forContext(ctx).day(project, day),
    );
  }
  @Get('people-window')
  async peopleWindow(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('businessDate') businessDate: unknown,
  ) {
    const identity = await this.identity(request);
    const project = id(projectId, 'projectId');
    const day = date(businessDate, 'businessDate');
    return this.store.read(identity, (ctx) =>
      reportReader.forContext(ctx).peopleWindow(project, day),
    );
  }
  @Get('revision')
  async revision(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('businessDate') businessDate: unknown,
    @Query('n') n: unknown,
  ) {
    const identity = await this.identity(request);
    const number = Number(n);
    if (!Number.isInteger(number) || number < 1 || number > 1_000_000)
      throw new InvalidReportInput('n');
    const project = id(projectId, 'projectId');
    const day = date(businessDate, 'businessDate');
    return this.store.read(identity, (ctx) =>
      reportReader.forContext(ctx).revision(project, day, number),
    );
  }
  @Get('plan')
  async plan(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('targetBusinessDate') target: unknown,
  ) {
    const identity = await this.identity(request);
    const project = id(projectId, 'projectId');
    const day = date(target, 'targetBusinessDate');
    return this.store.read(identity, (ctx) =>
      reportReader.forContext(ctx).plan(project, day),
    );
  }
  @Get('items')
  async items(@Req() request: Request, @Query('projectId') projectId: unknown) {
    const identity = await this.identity(request);
    const project = id(projectId, 'projectId');
    return this.store.read(identity, (ctx) =>
      reportReader.forContext(ctx).items(project),
    );
  }

  @Post('facts')
  @HttpCode(200)
  async saveFacts(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.saveFacts(
      identity,
      this.command(parseSaveFactsCommand, body, key),
    );
  }
  @Post('submit')
  @HttpCode(200)
  async submit(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.submit(
      identity,
      this.command(parseSubmitReportCommand, body, key),
    );
  }
  @Post('no-work')
  @HttpCode(200)
  async noWork(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.noWork(
      identity,
      this.command(parseNoWorkCommand, body, key),
    );
  }
  @Post('correction/start')
  @HttpCode(200)
  async startCorrection(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.startCorrection(
      identity,
      this.command(parseStartCorrectionCommand, body, key),
    );
  }
  @Post('correction/cancel')
  @HttpCode(200)
  async cancelCorrection(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.cancelCorrection(
      identity,
      this.command(parseCancelCorrectionCommand, body, key),
    );
  }
  @Post('plan/draft')
  @HttpCode(200)
  async savePlanDraft(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.savePlanDraft(
      identity,
      this.command(parseSavePlanDraftCommand, body, key),
    );
  }
  @Post('plan/confirm')
  @HttpCode(200)
  async confirmPlan(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.confirmPlan(
      identity,
      this.command(parseConfirmPlanCommand, body, key),
    );
  }
  @Post('items')
  @HttpCode(200)
  async saveItems(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.saveItems(
      identity,
      this.command(parseSaveItemsCommand, body, key),
    );
  }
}

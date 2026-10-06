import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { OpportunityCommands, OpportunityReader } from '@mje/domain';
import {
  InvalidReportInput,
  parseCreateOpportunity,
  parseUpdateOpportunity,
  parseRequestOpportunityDecision,
  parseRecordOpportunityDecision,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';
@Controller('api/opportunities')
export class OpportunityController {
  constructor(
    @Inject(OpportunityCommands) private readonly commands: OpportunityCommands,
    @Inject(OpportunityReader) private readonly reader: OpportunityReader,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(r: Request) {
    try {
      return await this.verifier.verify(r.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  private id(raw: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        raw,
      )
    )
      throw new InvalidReportInput('opportunityId');
    return raw.toLowerCase();
  }
  private key(raw: unknown, mutation: string) {
    if (typeof raw !== 'string' || raw.toLowerCase() !== mutation)
      throw new InvalidReportInput('Idempotency-Key');
    return mutation;
  }
  @Get() async list(@Req() r: Request) {
    return this.reader.list(await this.identity(r));
  }
  @Get('lookups') async lookups(@Req() r: Request) {
    return this.reader.lookups(await this.identity(r));
  }
  @Get('worklists') async worklists(@Req() r: Request) {
    return this.reader.worklists(await this.identity(r));
  }
  @Get(':id') async detail(@Param('id') id: string, @Req() r: Request) {
    return this.reader.detail(await this.identity(r), this.id(id));
  }
  @Get(':id/history') async history(
    @Param('id') id: string,
    @Req() r: Request,
  ) {
    return this.reader.history(await this.identity(r), this.id(id));
  }
  @Post() @HttpCode(200) async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: Request,
  ) {
    const identity = await this.identity(r),
      c = parseCreateOpportunity(body);
    return this.commands.create(
      identity,
      c,
      this.key(key, c.clientMutationId),
      randomUUID(),
    );
  }
  @Post(':id/updates') @HttpCode(200) async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: Request,
  ) {
    const identity = await this.identity(r),
      c = parseUpdateOpportunity(body);
    if (this.id(id) !== c.opportunityId)
      throw new InvalidReportInput('opportunityId');
    return this.commands.update(
      identity,
      c,
      this.key(key, c.clientMutationId),
      randomUUID(),
    );
  }
  @Post(':id/requests') @HttpCode(200) async request(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: Request,
  ) {
    const identity = await this.identity(r),
      c = parseRequestOpportunityDecision(body);
    if (this.id(id) !== c.opportunityId)
      throw new InvalidReportInput('opportunityId');
    return this.commands.request(
      identity,
      c,
      this.key(key, c.clientMutationId),
      randomUUID(),
    );
  }
  @Post(':id/decisions') @HttpCode(200) async decide(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: Request,
  ) {
    const identity = await this.identity(r),
      c = parseRecordOpportunityDecision(body);
    if (this.id(id) !== c.opportunityId)
      throw new InvalidReportInput('opportunityId');
    return this.commands.decide(
      identity,
      c,
      this.key(key, c.clientMutationId),
      randomUUID(),
    );
  }
}

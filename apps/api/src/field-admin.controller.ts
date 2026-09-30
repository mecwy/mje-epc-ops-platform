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
import { FieldStore } from '@mje/domain';
import {
  InvalidReportInput,
  parseCreateCrewCommand,
  parseEndCrewCommand,
  parseRosterChangesCommand,
  parseRotateEntryCodeCommand,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function projectId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new InvalidReportInput('projectId');
  return value.toLowerCase();
}

/**
 * Project-manager field routes (A6a-1): roster and the entry code. Entra only; the store
 * requires PROJECT_MANAGER of the resource's project (a reader gets READ_ONLY).
 */
@Controller('api/report/field')
export class FieldAdminController {
  constructor(
    @Inject(FieldStore) private readonly store: FieldStore,
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
    if (key !== command.clientMutationId)
      throw new InvalidReportInput('Idempotency-Key');
    return command;
  }

  @Get('roster')
  async roster(@Req() request: Request, @Query('projectId') id: unknown) {
    return this.store.roster(await this.identity(request), projectId(id));
  }
  @Post('crews')
  @HttpCode(200)
  async createCrew(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.createCrew(
      identity,
      this.command(parseCreateCrewCommand, body, key),
    );
  }
  @Post('crews/end')
  @HttpCode(200)
  async endCrew(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.endCrew(
      identity,
      this.command(parseEndCrewCommand, body, key),
    );
  }
  @Post('roster/changes')
  @HttpCode(200)
  async changeRoster(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.changeRoster(
      identity,
      this.command(parseRosterChangesCommand, body, key),
    );
  }
  @Post('entry-code/rotate')
  @HttpCode(200)
  async rotateEntryCode(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.rotateEntryCode(
      identity,
      this.command(parseRotateEntryCodeCommand, body, key),
    );
  }
}

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
import { AlphaStore } from '@mje/domain';
import { InvalidAlphaInput, parseSaveAlphaCommand } from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new InvalidAlphaInput('id');
  return value.toLowerCase();
}
@Controller('api')
export class AlphaController {
  constructor(
    @Inject(AlphaStore) private readonly store: AlphaStore,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(request: Request) {
    try {
      return await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  @Get('projects')
  async projects(@Req() request: Request) {
    return this.store.projects(await this.identity(request));
  }
  @Get('site-days')
  async list(@Req() request: Request, @Query('projectId') projectId: unknown) {
    const identity = await this.identity(request);
    return this.store.list(identity, id(projectId));
  }
  @Get('site-days/:recordId')
  async get(@Req() request: Request, @Param('recordId') recordId: unknown) {
    const identity = await this.identity(request);
    return this.store.get(identity, id(recordId));
  }
  @Post('site-days/save')
  @HttpCode(200)
  async save(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    const command = parseSaveAlphaCommand(body);
    if (id(key) !== command.clientMutationId)
      throw new InvalidAlphaInput('Idempotency-Key');
    return this.store.save(identity, command);
  }
}

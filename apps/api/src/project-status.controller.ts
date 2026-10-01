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
import {
  ProjectStatusCommands,
  ProjectStatusReader,
  projectStatusReader,
} from '@mje/domain';
import {
  InvalidReportInput,
  parseDeclareStatusCommand,
  parseAddStatusNoteCommand,
  statusSequence,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
@Controller('api/projects')
export class ProjectStatusController {
  constructor(
    @Inject(ProjectStatusCommands)
    private readonly commands: ProjectStatusCommands,
    @Inject(ProjectStatusReader) private readonly reader: ProjectStatusReader,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(r: Request) {
    try {
      return await this.verifier.verify(r.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  private id(s: string) {
    if (!uuid.test(s)) throw new InvalidReportInput('projectId');
    return s.toLowerCase();
  }
  private key(key: unknown, value: string) {
    if (
      typeof key !== 'string' ||
      !uuid.test(key) ||
      key.toLowerCase() !== value
    )
      throw new InvalidReportInput('Idempotency-Key');
  }
  @Get(':id/status')
  async status(
    @Param('id') id: string,
    @Query('page') page: string | undefined,
    @Req() request: Request,
  ) {
    const projectId = this.id(id),
      p = page === undefined ? 1 : Number(page);
    if (!Number.isInteger(p) || p < 1 || p > 1_000_000)
      throw new InvalidReportInput('page');
    return this.reader.read(await this.identity(request), (ctx) =>
      projectStatusReader.forContext(ctx).history(projectId, p),
    );
  }
  @Post(':id/status')
  @HttpCode(200)
  async declare(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() request: Request,
  ) {
    const c = parseDeclareStatusCommand(body, this.id(id));
    this.key(key, c.clientMutationId);
    return this.commands.declareStatus(await this.identity(request), c);
  }
  @Post(':id/status/:n/notes')
  @HttpCode(200)
  async note(
    @Param('id') id: string,
    @Param('n') n: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() request: Request,
  ) {
    if (!/^[1-9]\d*$/.test(n)) throw new InvalidReportInput('n');
    const c = parseAddStatusNoteCommand(
      body,
      this.id(id),
      statusSequence(Number(n)),
    );
    this.key(key, c.clientMutationId);
    return this.commands.addStatusNote(await this.identity(request), c);
  }
}

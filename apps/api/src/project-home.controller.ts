import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { InvalidReportInput } from '@mje/contracts';
import { ProjectHomeReader } from '@mje/domain';
import { TokenVerifier } from './auth/token-verifier.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set([
  'NORMAL',
  'AT_RISK',
  'OFF_TRACK',
  'PAUSED',
  'STALE',
  'UNDECLARED',
]);
const GROUPS = new Set(['region', 'manager', 'type']);

@Controller('api')
export class ProjectHomeController {
  constructor(
    @Inject(ProjectHomeReader) private readonly reader: ProjectHomeReader,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}

  private async identity(request: Request) {
    try {
      return await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }

  @Get('projects/home')
  async home(@Query() query: Record<string, unknown>, @Req() request: Request) {
    const groupBy = query['group'] ?? 'region';
    const status = query['status'] ?? null;
    const q = query['q'] ?? '';
    const page = query['page'] === undefined ? 1 : Number(query['page']);
    const size = query['size'] === undefined ? 50 : Number(query['size']);
    if (typeof groupBy !== 'string' || !GROUPS.has(groupBy))
      throw new InvalidReportInput('group');
    if (status !== null && (typeof status !== 'string' || !STATES.has(status)))
      throw new InvalidReportInput('status');
    if (typeof q !== 'string' || q.length > 160)
      throw new InvalidReportInput('q');
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000)
      throw new InvalidReportInput('page');
    if (!Number.isInteger(size) || size < 1 || size > 100)
      throw new InvalidReportInput('size');
    return this.reader.home(await this.identity(request), {
      groupBy: groupBy as 'region' | 'manager' | 'type',
      status: status as
        | 'NORMAL'
        | 'AT_RISK'
        | 'OFF_TRACK'
        | 'PAUSED'
        | 'STALE'
        | 'UNDECLARED'
        | null,
      query: q,
      page,
      size,
    });
  }

  @Get('attention')
  async attention(@Req() request: Request) {
    return this.reader.attention(await this.identity(request));
  }

  @Get('projects/:id/overview')
  async overview(
    @Param('id') id: string,
    @Query('statusPage') statusPage: string | undefined,
    @Req() request: Request,
  ) {
    if (!UUID.test(id)) throw new InvalidReportInput('projectId');
    const page = statusPage === undefined ? 1 : Number(statusPage);
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000)
      throw new InvalidReportInput('statusPage');
    return this.reader.overview(
      await this.identity(request),
      id.toLowerCase(),
      page,
    );
  }
}

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
import type { BusinessEvidenceService } from '@mje/contracts';
import {
  InvalidReportInput,
  parseBusinessEvidenceCommand,
  parseBusinessEvidenceQuery,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';

export const BUSINESS_EVIDENCE_SERVICE = Symbol('BUSINESS_EVIDENCE_SERVICE');
/** Parent registers an actual service and its error mapping. No default service or login bypass. */
@Controller('api/report/business-evidence')
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

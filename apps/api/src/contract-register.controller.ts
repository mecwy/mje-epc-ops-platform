import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ContractRegisterReader } from '@mje/domain';
import { InvalidReportInput } from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';
@Controller('api/contracts')
export class ContractRegisterController {
  constructor(
    @Inject(ContractRegisterReader)
    private readonly reader: ContractRegisterReader,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(request: Request) {
    try {
      return await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  private id(value: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw new InvalidReportInput('contractId');
    return value.toLowerCase();
  }
  @Get() async list(@Req() request: Request) {
    return this.reader.list(await this.identity(request));
  }
  @Get(':id') async detail(@Param('id') id: string, @Req() request: Request) {
    return this.reader.detail(await this.identity(request), this.id(id));
  }
  @Get(':id/history') async history(
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.reader.history(await this.identity(request), this.id(id));
  }
}

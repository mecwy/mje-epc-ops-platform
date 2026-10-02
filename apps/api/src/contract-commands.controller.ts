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
import { ContractRegisterCommands, ContractRegisterReader } from '@mje/domain';
import {
  InvalidReportInput,
  parseCreateContract,
  parseCorrectContract,
  parseContractShares,
  parseContractAttentionRead,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';
@Controller('api/contracts')
export class ContractCommandsController {
  constructor(
    @Inject(ContractRegisterCommands)
    private readonly commands: ContractRegisterCommands,
    @Inject(ContractRegisterReader)
    private readonly reader: ContractRegisterReader,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(r: Request) {
    try {
      return await this.verifier.verify(r.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  private key(key: unknown, mutationId: string): string {
    if (typeof key !== 'string' || key.toLowerCase() !== mutationId)
      throw new InvalidReportInput('Idempotency-Key');
    return mutationId;
  }
  @Get(':id/editor') async editor(@Param('id') id: string, @Req() r: Request) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new InvalidReportInput('contractId');
    return this.reader.editor(await this.identity(r), id.toLowerCase());
  }
  @Post() @HttpCode(200) async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: Request,
  ) {
    const identity = await this.identity(r),
      command = parseCreateContract(body);
    return this.commands.create(
      identity,
      command,
      this.key(key, command.clientMutationId),
      randomUUID(),
    );
  }
  @Post(':id/corrections') @HttpCode(200) async correct(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: Request,
  ) {
    const identity = await this.identity(r),
      command = parseCorrectContract(body);
    if (id.toLowerCase() !== command.contractId)
      throw new InvalidReportInput('contractId');
    return this.commands.correct(
      identity,
      command,
      this.key(key, command.clientMutationId),
      randomUUID(),
    );
  }
  @Post(':id/shares') @HttpCode(200) async shares(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: Request,
  ) {
    const identity = await this.identity(r),
      command = parseContractShares(body);
    if (id.toLowerCase() !== command.contractId)
      throw new InvalidReportInput('contractId');
    return this.commands.shares(
      identity,
      command,
      this.key(key, command.clientMutationId),
      randomUUID(),
    );
  }
  @Post(':id/attention/read') @HttpCode(200) async readAttention(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: Request,
  ) {
    const identity = await this.identity(r),
      command = parseContractAttentionRead(body);
    if (id.toLowerCase() !== command.contractId)
      throw new InvalidReportInput('contractId');
    return this.commands.readAttention(
      identity,
      command,
      this.key(key, command.clientMutationId),
    );
  }
}

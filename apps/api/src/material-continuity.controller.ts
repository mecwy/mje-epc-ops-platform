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
import { MaterialContinuityStore } from '@mje/domain';
import {
  InvalidReportInput,
  isRealDate,
  parseInitializeMaterialScope,
  parseAdmitMaterialUse,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';

/** Existing report membership only; no client tenant, role, quantity or verification grant. */
@Controller('api/report/material-quantity')
export class MaterialContinuityController {
  constructor(
    @Inject(MaterialContinuityStore)
    private readonly store: MaterialContinuityStore,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(request: Request) {
    try {
      return await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }
  @Get() async view(
    @Req() request: Request,
    @Query('projectId') projectId: string,
    @Query('businessDate') businessDate: string,
    @Query('revisionNumber') n?: string,
  ) {
    if (
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
        projectId,
      ) ||
      !isRealDate(businessDate)
    )
      throw new InvalidReportInput('material.query');
    if (n !== undefined && !/^[1-9]\d{0,5}$/.test(n))
      throw new InvalidReportInput('material.revisionNumber');
    return this.store.view(
      await this.identity(request),
      projectId,
      businessDate,
      n === undefined ? undefined : Number(n),
    );
  }
  @Post('initialize') @HttpCode(200) async initialize(
    @Req() request: Request,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const command = parseInitializeMaterialScope(body);
    if (key !== command.clientMutationId)
      throw new InvalidReportInput('clientMutationId');
    return this.store.initialize(await this.identity(request), command);
  }
  @Post('admit') @HttpCode(200) async admit(
    @Req() request: Request,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const command = parseAdmitMaterialUse(body);
    if (key !== command.clientMutationId)
      throw new InvalidReportInput('clientMutationId');
    return this.store.admit(await this.identity(request), command);
  }
}

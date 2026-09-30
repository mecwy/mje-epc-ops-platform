import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { FieldError, FieldStore, hashSecret } from '@mje/domain';
import {
  InvalidReportInput,
  fieldBearer,
  parseBindCommand,
  parseChallengeConfirmCommand,
  parseChallengeRejectCommand,
  parseEntryCommand,
  parseReleaseCommand,
  parseRotateCommand,
} from '@mje/contracts';

type FieldRequest = Request & { fieldTokenHash?: string };
/**
 * Device-token authentication, separate from Entra: only a well-formed `Bearer fd1.*` passes,
 * and only its sha256 travels on (the token itself is never stored, logged or echoed). The
 * store then authenticates the hash against the database.
 */
@Injectable()
export class FieldTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FieldRequest>();
    const token = fieldBearer(request.headers.authorization);
    if (!token) throw new FieldError('FIELD_AUTH_REQUIRED');
    request.fieldTokenHash = hashSecret(token);
    return true;
  }
}
const tokenHash = (request: FieldRequest) => request.fieldTokenHash!;
const clientIp = (request: Request) => request.ip ?? 'unknown';
function keyed<T extends { clientMutationId: string }>(
  parse: (body: unknown) => T,
  body: unknown,
  key: unknown,
): T {
  const command = parse(body);
  if (key !== command.clientMutationId)
    throw new InvalidReportInput('Idempotency-Key');
  return command;
}

/**
 * Field routes (A6a). Bodies carry no projectId: the project is the device's. Entry and bind
 * use the project entry code; every other route a device token.
 */
@Controller('api/field')
export class FieldController {
  constructor(@Inject(FieldStore) private readonly store: FieldStore) {}

  @Post('entry')
  @HttpCode(200)
  entry(@Req() request: Request, @Body() body: unknown) {
    return this.store.entry(clientIp(request), parseEntryCommand(body));
  }
  @Post('bind')
  @HttpCode(200)
  bind(@Req() request: Request, @Body() body: unknown) {
    return this.store.bind(clientIp(request), parseBindCommand(body));
  }
  @Get('me')
  @UseGuards(FieldTokenGuard)
  me(@Req() request: FieldRequest) {
    return this.store.me(clientIp(request), tokenHash(request));
  }
  @Post('device/challenge')
  @HttpCode(200)
  @UseGuards(FieldTokenGuard)
  challenge(@Req() request: FieldRequest) {
    return this.store.challenge(clientIp(request), tokenHash(request));
  }
  @Post('device/release')
  @HttpCode(200)
  @UseGuards(FieldTokenGuard)
  release(
    @Req() request: FieldRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.store.release(
      clientIp(request),
      tokenHash(request),
      keyed(parseReleaseCommand, body, key),
    );
  }
  @Post('device/rotate')
  @HttpCode(200)
  @UseGuards(FieldTokenGuard)
  rotate(@Req() request: FieldRequest, @Body() body: unknown) {
    return this.store.rotate(
      clientIp(request),
      tokenHash(request),
      parseRotateCommand(body),
    );
  }
  @Post('devices/confirm')
  @HttpCode(200)
  @UseGuards(FieldTokenGuard)
  confirm(
    @Req() request: FieldRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.store.confirm(
      clientIp(request),
      tokenHash(request),
      keyed(parseChallengeConfirmCommand, body, key),
    );
  }
  @Post('devices/reject')
  @HttpCode(200)
  @UseGuards(FieldTokenGuard)
  reject(
    @Req() request: FieldRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.store.reject(
      clientIp(request),
      tokenHash(request),
      keyed(parseChallengeRejectCommand, body, key),
    );
  }
}

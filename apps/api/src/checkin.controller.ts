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
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import { CheckInStore, FieldError, SELFIE_MAX_BYTES } from '@mje/domain';
import {
  InvalidReportInput,
  UPLOAD_SELFIE_FIELDS,
  isRealDate,
  parseCheckInCommand,
  parseFieldSettingsCommand,
  parsePmProxyCheckInCommand,
  parseProxyCheckInCommand,
  parseSelfieUploadCommand,
  parseSiteReferenceCommand,
  parseVoidCheckInCommand,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';
import { FieldTokenGuard } from './field.controller.js';

type FieldRequest = Request & { fieldTokenHash?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new InvalidReportInput(field);
  return value.toLowerCase();
}
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
const clientIp = (request: Request) => request.ip ?? 'unknown';

/** One selfie (≤ 3 MB), parsed in memory only after the device token passed the guard. */
const multipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SELFIE_MAX_BYTES,
    files: 1,
    fields: UPLOAD_SELFIE_FIELDS.length,
    parts: UPLOAD_SELFIE_FIELDS.length + 1,
    fieldNameSize: 32,
    fieldSize: 64,
    headerPairs: 20,
  },
}).single('selfie');
function parseMultipart(request: Request, response: Response) {
  if (!request.is('multipart/form-data'))
    return Promise.reject(new InvalidReportInput('Content-Type'));
  return new Promise<void>((resolve, reject) =>
    multipart(request, response, (error: unknown) => {
      if (!error) return resolve();
      if (error instanceof multer.MulterError)
        return reject(
          error.code === 'LIMIT_FILE_SIZE'
            ? new FieldError('SELFIE_TOO_LARGE')
            : new InvalidReportInput(error.field ?? error.code),
        );
      reject(new InvalidReportInput('multipart'));
    }),
  );
}

/**
 * Worker check-in and staged selfie (A6b). Device token only; bodies carry no projectId (the
 * project is the device's). The store runs authentication, authority, idempotency and every
 * time and geofence rule.
 */
@Controller('api/field')
@UseGuards(FieldTokenGuard)
export class CheckInController {
  constructor(@Inject(CheckInStore) private readonly store: CheckInStore) {}

  @Post('checkin')
  @HttpCode(200)
  checkIn(
    @Req() request: FieldRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.store.checkIn(
      clientIp(request),
      request.fieldTokenHash!,
      keyed(parseCheckInCommand, body, key),
    );
  }
  @Post('checkin/proxy')
  @HttpCode(200)
  proxy(
    @Req() request: FieldRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.store.proxyCheckIn(
      clientIp(request),
      request.fieldTokenHash!,
      keyed(parseProxyCheckInCommand, body, key),
    );
  }
  @Post('selfie')
  @HttpCode(200)
  async selfie(
    @Req() request: FieldRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') key: unknown,
  ) {
    await parseMultipart(request, response);
    const f = request.file;
    if (!f) throw new InvalidReportInput('selfie');
    const command = keyed(
      parseSelfieUploadCommand,
      { ...(request.body as Record<string, unknown>) },
      key,
    );
    return this.store.uploadSelfie(
      clientIp(request),
      request.fieldTokenHash!,
      command,
      { bytes: f.buffer, mediaType: f.mimetype },
    );
  }
}

/**
 * Project-manager check-in routes (A6b): list, selfie read, proxy, void, site reference and
 * field settings. Entra only; the store requires PROJECT_MANAGER of the project (a reader gets
 * READ_ONLY: check-ins are writer data).
 */
@Controller('api/report/field')
export class CheckInAdminController {
  constructor(
    @Inject(CheckInStore) private readonly store: CheckInStore,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  private async identity(request: Request) {
    try {
      return await this.verifier.verify(request.headers.authorization);
    } catch {
      throw new UnauthorizedException('LOGIN_REQUIRED');
    }
  }

  @Get('checkins')
  async list(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('businessDate') businessDate: unknown,
  ) {
    const identity = await this.identity(request);
    if (typeof businessDate !== 'string' || !isRealDate(businessDate))
      throw new InvalidReportInput('businessDate');
    return this.store.checkIns(
      identity,
      id(projectId, 'projectId'),
      businessDate,
    );
  }
  @Get('checkins/selfie')
  async selfie(
    @Req() request: Request,
    @Res() response: Response,
    @Query('projectId') projectId: unknown,
    @Query('checkInId') checkInId: unknown,
  ) {
    const identity = await this.identity(request);
    const content = await this.store.selfie(
      identity,
      id(projectId, 'projectId'),
      id(checkInId, 'checkInId'),
    );
    response
      .status(200)
      .setHeader('Content-Type', content.mediaType)
      .setHeader('Content-Length', String(content.bytes.length))
      .setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      .setHeader('Content-Disposition', 'inline')
      .end(Buffer.from(content.bytes));
  }
  @Post('checkins/proxy')
  @HttpCode(200)
  async proxy(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.pmProxy(
      identity,
      keyed(parsePmProxyCheckInCommand, body, key),
    );
  }
  @Post('checkins/void')
  @HttpCode(200)
  async void(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.voidCheckIn(
      identity,
      keyed(parseVoidCheckInCommand, body, key),
    );
  }
  @Get('settings')
  async settings(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.settings(identity, id(projectId, 'projectId'));
  }
  @Post('settings')
  @HttpCode(200)
  async setSettings(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.setSettings(
      identity,
      keyed(parseFieldSettingsCommand, body, key),
    );
  }
  @Post('site-reference')
  @HttpCode(200)
  async setSiteReference(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.setSiteReference(
      identity,
      keyed(parseSiteReferenceCommand, body, key),
    );
  }
}

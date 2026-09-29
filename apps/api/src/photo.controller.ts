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
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import {
  PHOTO_MAX_BYTES,
  PhotoStore,
  ReportError,
  type PhotoFile,
} from '@mje/domain';
import {
  InvalidReportInput,
  UPLOAD_PHOTO_FIELDS,
  isRealDate,
  parseLinkPhotoCommand,
  parseUnlinkPhotoCommand,
  parseUploadPhotoCommand,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new InvalidReportInput(field);
  return value.toLowerCase();
}
function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isRealDate(value))
    throw new InvalidReportInput(field);
  return value;
}

/**
 * One photo (≤ 10 MB) and an optional client-made thumbnail; the store checks each against its
 * own limit and the magic bytes. Parsed only after the caller is authenticated, in memory.
 */
const multipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: PHOTO_MAX_BYTES,
    files: 2,
    fields: UPLOAD_PHOTO_FIELDS.length,
    parts: UPLOAD_PHOTO_FIELDS.length + 2,
    fieldNameSize: 32,
    fieldSize: 256,
    headerPairs: 20,
  },
}).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);
function parseMultipart(request: Request, response: Response) {
  if (!request.is('multipart/form-data'))
    return Promise.reject(new InvalidReportInput('Content-Type'));
  return new Promise<void>((resolve, reject) =>
    multipart(request, response, (error: unknown) => {
      if (!error) return resolve();
      if (error instanceof multer.MulterError)
        return reject(
          error.code === 'LIMIT_FILE_SIZE'
            ? new ReportError('PHOTO_TOO_LARGE')
            : new InvalidReportInput(error.field ?? error.code),
        );
      reject(new InvalidReportInput('multipart'));
    }),
  );
}
type Files = Record<string, Express.Multer.File[] | undefined>;
const file = (f: Express.Multer.File | undefined): PhotoFile | null =>
  f ? { bytes: f.buffer, mediaType: f.mimetype } : null;
function sendImage(
  response: Response,
  content: { bytes: Uint8Array; mediaType: string },
) {
  response
    .status(200)
    .setHeader('Content-Type', content.mediaType)
    .setHeader('Content-Length', String(content.bytes.length))
    .setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    .setHeader('Content-Disposition', 'inline')
    .end(Buffer.from(content.bytes));
}

/**
 * Photo routes (U2.1 rule 8). Authorization, idempotency, link versions and audit live in
 * PhotoStore; bytes are only ever streamed through here, never as a blob URL or SAS.
 */
@Controller('api/report/photos')
export class PhotoController {
  constructor(
    @Inject(PhotoStore) private readonly store: PhotoStore,
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
    if (id(key, 'Idempotency-Key') !== command.clientMutationId)
      throw new InvalidReportInput('Idempotency-Key');
    return command;
  }

  @Get()
  async list(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('businessDate') businessDate: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.list(
      identity,
      id(projectId, 'projectId'),
      date(businessDate, 'businessDate'),
    );
  }
  @Get(':photoId/meta')
  async meta(@Req() request: Request, @Param('photoId') photoId: unknown) {
    const identity = await this.identity(request);
    return this.store.get(identity, id(photoId, 'photoId'));
  }
  @Get(':photoId')
  async photo(
    @Req() request: Request,
    @Res() response: Response,
    @Param('photoId') photoId: unknown,
  ) {
    const identity = await this.identity(request);
    sendImage(
      response,
      await this.store.content(identity, id(photoId, 'photoId'), 'photo'),
    );
  }
  @Get(':photoId/thumbnail')
  async thumbnail(
    @Req() request: Request,
    @Res() response: Response,
    @Param('photoId') photoId: unknown,
  ) {
    const identity = await this.identity(request);
    sendImage(
      response,
      await this.store.content(identity, id(photoId, 'photoId'), 'thumbnail'),
    );
  }

  @Post()
  @HttpCode(200)
  async upload(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') key: unknown,
  ) {
    // Authenticate before reading a byte of the body.
    const identity = await this.identity(request);
    await parseMultipart(request, response);
    const files = (request.files ?? {}) as Files;
    const photo = file(files['photo']?.[0]);
    if (!photo) throw new InvalidReportInput('photo');
    const command = this.command(
      parseUploadPhotoCommand,
      { ...(request.body as Record<string, unknown>) },
      key,
    );
    return this.store.upload(identity, {
      command,
      photo,
      thumbnail: file(files['thumbnail']?.[0]),
    });
  }
  @Post('link')
  @HttpCode(200)
  async link(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.link(
      identity,
      this.command(parseLinkPhotoCommand, body, key),
    );
  }
  @Post('unlink')
  @HttpCode(200)
  async unlink(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const identity = await this.identity(request);
    return this.store.unlink(
      identity,
      this.command(parseUnlinkPhotoCommand, body, key),
    );
  }
}

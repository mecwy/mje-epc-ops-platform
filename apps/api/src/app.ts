import 'reflect-metadata';
import {
  ArgumentsHost,
  Catch,
  Controller,
  Get,
  HttpException,
  Module,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  AlphaError,
  AlphaStore,
  FieldError,
  FieldStore,
  ForemanStore,
  IssueStore,
  PhotoStore,
  ReportError,
  ReportStore,
} from '@mje/domain';
import { InvalidAlphaInput, InvalidReportInput } from '@mje/contracts';
import { AlphaController } from './alpha.controller.js';
import { ReportController } from './report.controller.js';
import { IssueController } from './issue.controller.js';
import { PhotoController } from './photo.controller.js';
import { FieldController, FieldTokenGuard } from './field.controller.js';
import { FieldAdminController } from './field-admin.controller.js';
import {
  ForemanAdoptController,
  ForemanFieldController,
} from './foreman.controller.js';
import {
  TokenVerifier,
  type TokenConfiguration,
} from './auth/token-verifier.js';
import { trustProxySetting } from './trust-proxy.js';

@Controller()
class HealthController {
  @Get('health/live') live() {
    return {
      service: 'api',
      status: 'ok',
      phase: 'phase-0',
      revision: process.env['SOURCE_REVISION'] ?? 'local-unreleased',
    };
  }
}
const FIELD_STATUS: Partial<Record<string, number>> = {
  FIELD_AUTH_REQUIRED: 401,
  DEVICE_ENDED: 401,
  DEVICE_PENDING: 403,
  FORBIDDEN: 403,
  NOT_FOREMAN: 403,
  SELF_CONFIRM: 403,
  NOT_FOUND: 404,
  ENTRY_CODE_INVALID: 404,
  PERSON_NOT_ROSTERED: 404,
  ITEM_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  RETRY: 503,
};
@Catch()
class SafeErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    let status = 500;
    let code = 'REQUEST_FAILED';
    if (error instanceof HttpException) {
      status = error.getStatus();
      code =
        status === 401
          ? 'LOGIN_REQUIRED'
          : status === 404
            ? 'NOT_FOUND'
            : 'INVALID_REQUEST';
    } else if (
      error instanceof InvalidAlphaInput ||
      error instanceof InvalidReportInput
    ) {
      status = 400;
      code = 'INVALID_INPUT';
    } else if (error instanceof FieldError) {
      code = error.code;
      status = FIELD_STATUS[code] ?? 409;
    } else if (error instanceof AlphaError || error instanceof ReportError) {
      code = error.code;
      status =
        code === 'FORBIDDEN' || code === 'READ_ONLY'
          ? 403
          : code === 'NOT_FOUND'
            ? 404
            : code === 'PHOTO_TOO_LARGE'
              ? 413
              : code === 'UNSUPPORTED_MEDIA'
                ? 415
                : 409;
    }
    // A deadlock or serialization failure is safe to repeat with the same key.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === '40P01' || error.code === '40001')
    ) {
      status = 503;
      code = 'RETRY';
    }
    if (error && typeof error === 'object' && 'type' in error) {
      if (error.type === 'entity.too.large') {
        status = 413;
        code = 'REQUEST_TOO_LARGE';
      }
      if (error.type === 'entity.parse.failed') {
        status = 400;
        code = 'INVALID_JSON';
      }
    }
    const correlationId = randomUUID();
    if (status === 500)
      console.error(JSON.stringify({ event: 'request_failed', correlationId }));
    host
      .switchToHttp()
      .getResponse<express.Response>()
      .status(status)
      .json({ code, correlationId });
  }
}
export interface AlphaRuntime {
  store: AlphaStore;
  /** Site Daily Close (U2.1); absent until the report slice is enabled. */
  reportStore?: ReportStore;
  /** Issues and escalation (U2.1 rule 10); served only together with the report slice. */
  issueStore?: IssueStore;
  /** Photos (U2.1 rule 8); served only together with the report slice and a blob store. */
  photoStore?: PhotoStore;
  /** Field roster, devices and entry (A6a); served only together with the report slice. */
  fieldStore?: FieldStore;
  /** Foreman quantity reports (A6c); served only together with the field slice. */
  foremanStore?: ForemanStore;
  verifier: TokenVerifier;
  auth: TokenConfiguration;
}
export async function createApp(alpha?: AlphaRuntime) {
  @Controller('api')
  class ConfigurationController {
    @Get('auth-config') config() {
      return alpha
        ? {
            enabled: true,
            tenantId: alpha.auth.tenantId,
            clientId: alpha.auth.clientId,
            scope: `api://${alpha.auth.audience}/${alpha.auth.scope}`,
          }
        : { enabled: false };
    }
  }
  @Module({
    controllers: [
      HealthController,
      ConfigurationController,
      ...(alpha ? [AlphaController] : []),
      ...(alpha?.reportStore ? [ReportController] : []),
      ...(alpha?.reportStore && alpha.issueStore ? [IssueController] : []),
      ...(alpha?.reportStore && alpha.photoStore ? [PhotoController] : []),
      ...(alpha?.reportStore && alpha.fieldStore
        ? [FieldController, FieldAdminController]
        : []),
      ...(alpha?.reportStore && alpha.fieldStore && alpha.foremanStore
        ? [ForemanFieldController, ForemanAdoptController]
        : []),
    ],
    providers: alpha
      ? [
          { provide: AlphaStore, useValue: alpha.store },
          { provide: TokenVerifier, useValue: alpha.verifier },
          ...(alpha.reportStore
            ? [{ provide: ReportStore, useValue: alpha.reportStore }]
            : []),
          ...(alpha.reportStore && alpha.issueStore
            ? [{ provide: IssueStore, useValue: alpha.issueStore }]
            : []),
          ...(alpha.reportStore && alpha.photoStore
            ? [{ provide: PhotoStore, useValue: alpha.photoStore }]
            : []),
          ...(alpha.reportStore && alpha.fieldStore
            ? [
                { provide: FieldStore, useValue: alpha.fieldStore },
                FieldTokenGuard,
              ]
            : []),
          ...(alpha.reportStore && alpha.fieldStore && alpha.foremanStore
            ? [{ provide: ForemanStore, useValue: alpha.foremanStore }]
            : []),
        ]
      : [],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: false,
  });
  // Field throttles key on the client IP; see trust-proxy.ts for how it is derived behind the
  // platform ingress without trusting client-chosen header entries.
  (app.getHttpAdapter().getInstance() as express.Express).set(
    'trust proxy',
    trustProxySetting(process.env),
  );
  app.use(
    (
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' https://login.microsoftonline.com; frame-src 'self' https://login.microsoftonline.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      next();
    },
  );
  app.use(express.json({ limit: '256kb', strict: true }));
  if (process.env['WEB_ROOT'])
    app.use(
      express.static(resolve(process.env['WEB_ROOT']), {
        dotfiles: 'deny',
        index: 'index.html',
      }),
    );
  app.useGlobalFilters(new SafeErrorFilter());
  app.enableShutdownHooks();
  return app;
}

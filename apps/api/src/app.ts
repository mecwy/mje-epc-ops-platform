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
import { AlphaError, AlphaStore, ReportError, ReportStore } from '@mje/domain';
import { InvalidAlphaInput, InvalidReportInput } from '@mje/contracts';
import { AlphaController } from './alpha.controller.js';
import { ReportController } from './report.controller.js';
import {
  TokenVerifier,
  type TokenConfiguration,
} from './auth/token-verifier.js';

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
    } else if (error instanceof AlphaError || error instanceof ReportError) {
      code = error.code;
      status =
        code === 'FORBIDDEN' || code === 'READ_ONLY'
          ? 403
          : code === 'NOT_FOUND'
            ? 404
            : 409;
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
    ],
    providers: alpha
      ? [
          { provide: AlphaStore, useValue: alpha.store },
          { provide: TokenVerifier, useValue: alpha.verifier },
          ...(alpha.reportStore
            ? [{ provide: ReportStore, useValue: alpha.reportStore }]
            : []),
        ]
      : [],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: false,
  });
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

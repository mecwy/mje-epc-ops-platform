import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { resolve } from 'node:path';
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
@Module({ controllers: [HealthController] })
class AppModule {}
const app = await NestFactory.create(AppModule);
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
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' https://login.microsoftonline.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  },
);
if (process.env['WEB_ROOT']) {
  app.use(
    express.static(resolve(process.env['WEB_ROOT']), {
      dotfiles: 'deny',
      index: 'index.html',
    }),
  );
}
app.enableShutdownHooks();
await app.listen(
  Number(process.env['PORT'] ?? 3300),
  process.env['HOST'] ?? '127.0.0.1',
);

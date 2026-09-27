import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
@Controller()
class HealthController {
  @Get('health/live') live() {
    return { service: 'api', status: 'ok', phase: 'phase-0' };
  }
}
@Module({ controllers: [HealthController] })
class AppModule {}
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(
  Number(process.env['PORT'] ?? 3300),
  process.env['HOST'] ?? '127.0.0.1',
);

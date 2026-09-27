import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
@Module({})
class WorkerModule {}
const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
// No timers or business work until the transactional outbox is implemented in Phase 1.
console.info(
  JSON.stringify({
    service: 'worker',
    phase: 'phase-0',
    status: 'boot-ok-no-jobs',
  }),
);
await app.close();

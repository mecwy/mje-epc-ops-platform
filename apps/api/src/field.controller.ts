import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { FieldStore } from '@mje/domain';
import { parseEntryCommand } from '@mje/contracts';

const clientIp = (request: Request) => request.ip ?? 'unknown';

/**
 * Field routes (A6a-1: the entry read). The entry code allows only the roster read; bind and
 * the device-token routes arrive with A6a-2 and their own guard, separate from Entra.
 */
@Controller('api/field')
export class FieldController {
  constructor(@Inject(FieldStore) private readonly store: FieldStore) {}

  @Post('entry')
  @HttpCode(200)
  entry(@Req() request: Request, @Body() body: unknown) {
    return this.store.entry(clientIp(request), parseEntryCommand(body));
  }
}

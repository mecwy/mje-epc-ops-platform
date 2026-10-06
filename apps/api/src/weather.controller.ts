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
import {
  InvalidReportInput,
  parseConfigureWeatherLocationCommand,
  parseWeatherRequestCommand,
  type ConfigureWeatherLocationCommand,
  type WeatherRequestCommand,
  type WeatherLocationDto,
  type WeatherRequestDto,
  type WeatherSnapshotDto,
  type ReportLocationCoordinatesDto,
} from '@mje/contracts';
import { TokenVerifier } from './auth/token-verifier.js';
/** Parent adapter wires reads through ReportStore.read + registered reportReader exits. */
export interface WeatherApiPort {
  configureLocation(
    identity: Awaited<ReturnType<TokenVerifier['verify']>>,
    command: ConfigureWeatherLocationCommand,
  ): Promise<WeatherLocationDto>;
  request(
    identity: Awaited<ReturnType<TokenVerifier['verify']>>,
    command: WeatherRequestCommand,
  ): Promise<WeatherRequestDto>;
  locations(
    identity: Awaited<ReturnType<TokenVerifier['verify']>>,
    projectId: string,
  ): Promise<WeatherLocationDto[]>;
  requestStatus(
    identity: Awaited<ReturnType<TokenVerifier['verify']>>,
    projectId: string,
    requestId: string,
  ): Promise<WeatherRequestDto>;
  snapshot(
    identity: Awaited<ReturnType<TokenVerifier['verify']>>,
    projectId: string,
    snapshotId: string,
  ): Promise<WeatherSnapshotDto>;
  coordinates(
    identity: Awaited<ReturnType<TokenVerifier['verify']>>,
    projectId: string,
    recordId: string,
  ): Promise<ReportLocationCoordinatesDto>;
}
function uuid(v: unknown, field: string) {
  if (
    typeof v !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)
  )
    throw new InvalidReportInput(field);
  return v.toLowerCase();
}
@Controller('api/weather')
export class WeatherController {
  constructor(
    @Inject('C03_WEATHER_API') private readonly api: WeatherApiPort,
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
    parse: (input: unknown) => T,
    body: unknown,
    key: unknown,
  ) {
    const command = parse(body);
    if (uuid(key, 'Idempotency-Key') !== command.clientMutationId)
      throw new InvalidReportInput('clientMutationId');
    return command;
  }
  @Post('locations')
  @HttpCode(200)
  async configure(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.api.configureLocation(
      await this.identity(request),
      this.command(parseConfigureWeatherLocationCommand, body, key),
    );
  }
  @Post('requests')
  @HttpCode(200)
  async requestWeather(
    @Req() request: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.api.request(
      await this.identity(request),
      this.command(parseWeatherRequestCommand, body, key),
    );
  }
  @Get('locations')
  async locations(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
  ) {
    return this.api.locations(
      await this.identity(request),
      uuid(projectId, 'projectId'),
    );
  }
  @Get('requests')
  async status(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('requestId') requestId: unknown,
  ) {
    return this.api.requestStatus(
      await this.identity(request),
      uuid(projectId, 'projectId'),
      uuid(requestId, 'requestId'),
    );
  }
  @Get('snapshots')
  async snapshot(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('snapshotId') snapshotId: unknown,
  ) {
    return this.api.snapshot(
      await this.identity(request),
      uuid(projectId, 'projectId'),
      uuid(snapshotId, 'snapshotId'),
    );
  }
  @Get('report-location/coordinates')
  async coordinates(
    @Req() request: Request,
    @Query('projectId') projectId: unknown,
    @Query('recordId') recordId: unknown,
  ) {
    return this.api.coordinates(
      await this.identity(request),
      uuid(projectId, 'projectId'),
      uuid(recordId, 'recordId'),
    );
  }
}

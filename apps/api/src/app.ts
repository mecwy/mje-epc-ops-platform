import { STATUS_FIELD_NAMES, type StatusFieldName } from '@mje/contracts';
import { ContractRegisterController } from './contract-register.controller.js';
import { OpportunityController } from './opportunity.controller.js';
import {
  ContractRegisterReader,
  OpportunityCommands,
  OpportunityReader,
  OpportunityError,
  ContractRegisterError,
  ContractRegisterCommands,
} from '@mje/domain';
import { ContractCommandsController } from './contract-commands.controller.js';
import { ProjectStatusController } from './project-status.controller.js';
import { ProjectHomeController } from './project-home.controller.js';
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
import { publicAssets } from './public-assets.js';
import { businessEntry } from './business-entry.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  AlphaError,
  AlphaStore,
  BlobDeadlineError,
  CheckInStore,
  FieldError,
  FieldStore,
  ForemanStore,
  IssueStore,
  PhotoStore,
  ReportError,
  ReportStore,
  reportReader,
  WeatherStore,
  WeatherStoreError,
  ManagerReviewStore,
  DENY_REVIEW_PORTS,
  type ReviewServerPorts,
  ProjectStatusCommands,
  ProjectStatusReader,
  ProjectHomeReader,
  ProjectStatusError,
  RETRY_SQLSTATES,
} from '@mje/domain';
import { InvalidAlphaInput, InvalidReportInput } from '@mje/contracts';
import { AlphaController } from './alpha.controller.js';
import {
  WeatherController,
  type WeatherApiPort,
} from './weather.controller.js';
import { ReportController } from './report.controller.js';
import {
  ManagerReviewController,
  MANAGER_REVIEW_SERVICE,
  type ManagerReviewService,
} from './manager-review.controller.js';
import { IssueController } from './issue.controller.js';
import { PhotoController } from './photo.controller.js';
import { FieldController, FieldTokenGuard } from './field.controller.js';
import { FieldAdminController } from './field-admin.controller.js';
import {
  CheckInAdminController,
  CheckInController,
} from './checkin.controller.js';
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
  PROXY_NOT_ALLOWED: 403,
  FEATURE_OFF: 403,
  SELFIE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  ITEM_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  RETRY: 503,
};
@Catch()
export class SafeErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    let status = 500;
    let code = 'REQUEST_FAILED';
    // Fixed envelope additions only: existing check-in facts or status field-name enums.
    let existing: FieldError['existing'];
    let fields: StatusFieldName[] | undefined;
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
    } else if (error instanceof OpportunityError) {
      code = error.code;
      status =
        code === 'NOT_FOUND'
          ? 404
          : code === 'FORBIDDEN'
            ? 403
            : [
                  'VERSION_CONFLICT',
                  'FIELD_CONFLICT',
                  'STEP_CONFLICT',
                  'REQUEST_CONFLICT',
                  'DECISION_CONFLICT',
                  'IDENTITY_EXISTS',
                ].includes(code)
              ? 409
              : 400;
    } else if (error instanceof ContractRegisterError) {
      code = error.code;
      status =
        code === 'NOT_FOUND'
          ? 404
          : code === 'FORBIDDEN'
            ? 403
            : code === 'VERSION_CONFLICT' || code === 'IDENTITY_EXISTS'
              ? 409
              : 400;
    } else if (error instanceof WeatherStoreError) {
      // Store failures carry a fixed code only; preserve outcome uncertainty in the generic envelope.
      status = 500;
      code = 'REQUEST_FAILED';
    } else if (error instanceof ProjectStatusError) {
      code = error.code;
      status =
        code === 'NOT_FOUND' || code === 'ITEM_NOT_FOUND'
          ? 404
          : code === 'READ_ONLY'
            ? 403
            : 409;
      if (code === 'STATUS_FIELDS_REQUIRED')
        fields = error.fields.filter((f) => STATUS_FIELD_NAMES.includes(f));
    } else if (error instanceof FieldError) {
      code = error.code;
      status = FIELD_STATUS[code] ?? 409;
      if (code === 'ALREADY_CHECKED_IN') existing = error.existing;
    } else if (error instanceof AlphaError || error instanceof ReportError) {
      code = error.code;
      status =
        code === 'FORBIDDEN' ||
        code === 'READ_ONLY' ||
        code === 'FEATURE_DISABLED'
          ? 403
          : code === 'NOT_FOUND'
            ? 404
            : code === 'PHOTO_TOO_LARGE'
              ? 413
              : code === 'UNSUPPORTED_MEDIA'
                ? 415
                : 409;
    }
    // Safe to repeat with the same key: a deadlock, serialization failure or lock_timeout, a
    // session the server ended at transaction_timeout / idle-in-transaction timeout (the
    // transaction rolled back; ADR-0003 D5), or a Blob call past its deadline.
    if (
      error instanceof BlobDeadlineError ||
      (error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        RETRY_SQLSTATES.includes(error.code))
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
      .json(
        fields
          ? { code, correlationId, fields }
          : existing
            ? { code, correlationId, existing }
            : { code, correlationId },
      );
  }
}
export interface AlphaRuntime {
  store: AlphaStore;
  /** Site Daily Close (U2.1); absent until the report slice is enabled. */
  reportStore?: ReportStore;
  /** TEST-enabled C03 runtime; absence keeps the weather routes disabled. */
  weatherStore?: WeatherStore;
  /** No title-based rights or fallback evidence; actual transaction adapters are explicit. */
  managerReviewStore?: ManagerReviewStore;
  managerReviewPorts?: ReviewServerPorts;
  projectStatusCommands?: ProjectStatusCommands;
  contractRegisterReader?: ContractRegisterReader;
  contractRegisterCommands?: ContractRegisterCommands;
  opportunityCommands?: OpportunityCommands;
  opportunityReader?: OpportunityReader;
  projectStatusReader?: ProjectStatusReader;
  projectHomeReader?: ProjectHomeReader;
  /** Issues and escalation (U2.1 rule 10); served only together with the report slice. */
  issueStore?: IssueStore;
  /** Photos (U2.1 rule 8); served only together with the report slice and a blob store. */
  photoStore?: PhotoStore;
  /** Field roster, devices and entry (A6a); served only together with the report slice. */
  fieldStore?: FieldStore;
  /** Worker check-in and staged selfie (A6b); served only together with the field slice. */
  checkInStore?: CheckInStore;
  /** Foreman quantity reports (A6c); served only together with the field slice. */
  foremanStore?: ForemanStore;
  verifier: TokenVerifier;
  auth: TokenConfiguration;
}
export interface ApplicationOptions {
  /** The sole resource owner participates in the normal Nest HTTP shutdown sequence. */
  resourceLifecycle?: {
    beforeApplicationShutdown: () => Promise<void>;
    onApplicationShutdown: () => Promise<void>;
  };
  /** Embedders may close the application themselves; default process signal hooks remain on. */
  installSignalHandlers?: boolean;
}
export async function createApp(
  alpha?: AlphaRuntime,
  options: ApplicationOptions = {},
) {
  const managerReviewService: ManagerReviewService | null =
    alpha?.reportStore && alpha.managerReviewStore
      ? {
          read: (identity, scope) =>
            alpha.reportStore!.read(identity, (ctx) =>
              reportReader
                .forContext(ctx)
                .managerReview(
                  scope,
                  alpha.managerReviewPorts ?? DENY_REVIEW_PORTS,
                ),
            ),
          write: (identity, command) =>
            alpha.managerReviewStore!.write(identity, command),
        }
      : null;
  const weatherApi: WeatherApiPort | null =
    alpha?.reportStore && alpha.weatherStore
      ? {
          configureLocation: (identity, command) =>
            alpha.weatherStore!.configureLocation(identity, command),
          request: (identity, command) =>
            alpha.weatherStore!.request(identity, command),
          locations: (identity, projectId) =>
            alpha.reportStore!.read(identity, (ctx) =>
              reportReader.forContext(ctx).weatherLocations(projectId),
            ),
          requestStatus: (identity, projectId, requestId) =>
            alpha.reportStore!.read(identity, (ctx) =>
              reportReader.forContext(ctx).weatherRequest(projectId, requestId),
            ),
          snapshot: (identity, projectId, snapshotId) =>
            alpha.reportStore!.read(identity, (ctx) =>
              reportReader
                .forContext(ctx)
                .weatherSnapshot(projectId, snapshotId),
            ),
          coordinates: (identity, projectId, recordId) =>
            alpha.reportStore!.read(identity, (ctx) =>
              reportReader
                .forContext(ctx)
                .reportLocationCoordinates(projectId, recordId),
            ),
        }
      : null;
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
      ...(alpha?.opportunityCommands && alpha.opportunityReader
        ? [OpportunityController]
        : []),
      ...(alpha?.contractRegisterReader ? [ContractRegisterController] : []),
      ...(alpha?.contractRegisterReader && alpha.contractRegisterCommands
        ? [ContractCommandsController]
        : []),
      ConfigurationController,
      ...(alpha ? [AlphaController] : []),
      ...(alpha?.reportStore ? [ReportController] : []),
      ...(weatherApi ? [WeatherController] : []),
      ...(managerReviewService ? [ManagerReviewController] : []),
      ...(alpha?.projectStatusCommands && alpha.projectStatusReader
        ? [ProjectStatusController]
        : []),
      ...(alpha?.reportStore && alpha.issueStore ? [IssueController] : []),
      ...(alpha?.reportStore &&
      alpha.projectHomeReader &&
      alpha.projectStatusReader &&
      alpha.issueStore
        ? [ProjectHomeController]
        : []),
      ...(alpha?.reportStore && alpha.photoStore ? [PhotoController] : []),
      ...(alpha?.reportStore && alpha.fieldStore
        ? [FieldController, FieldAdminController]
        : []),
      ...(alpha?.reportStore && alpha.fieldStore && alpha.checkInStore
        ? [CheckInController, CheckInAdminController]
        : []),
      ...(alpha?.reportStore && alpha.fieldStore && alpha.foremanStore
        ? [ForemanFieldController, ForemanAdoptController]
        : []),
    ],
    providers: [
      ...(options.resourceLifecycle
        ? [
            {
              provide: 'APPLICATION_RESOURCE_LIFECYCLE',
              useValue: options.resourceLifecycle,
            },
          ]
        : []),
      ...(alpha
        ? [
            { provide: AlphaStore, useValue: alpha.store },
            ...(alpha.opportunityCommands && alpha.opportunityReader
              ? [
                  {
                    provide: OpportunityCommands,
                    useValue: alpha.opportunityCommands,
                  },
                  {
                    provide: OpportunityReader,
                    useValue: alpha.opportunityReader,
                  },
                ]
              : []),
            ...(alpha.contractRegisterCommands
              ? [
                  {
                    provide: ContractRegisterCommands,
                    useValue: alpha.contractRegisterCommands,
                  },
                ]
              : []),
            ...(alpha.contractRegisterReader
              ? [
                  {
                    provide: ContractRegisterReader,
                    useValue: alpha.contractRegisterReader,
                  },
                ]
              : []),
            ...(managerReviewService
              ? [
                  {
                    provide: MANAGER_REVIEW_SERVICE,
                    useValue: managerReviewService,
                  },
                ]
              : []),
            ...(weatherApi
              ? [{ provide: 'C03_WEATHER_API', useValue: weatherApi }]
              : []),
            ...(alpha.projectStatusCommands && alpha.projectStatusReader
              ? [
                  {
                    provide: ProjectStatusCommands,
                    useValue: alpha.projectStatusCommands,
                  },
                  {
                    provide: ProjectStatusReader,
                    useValue: alpha.projectStatusReader,
                  },
                ]
              : []),
            ...(alpha.projectHomeReader
              ? [
                  {
                    provide: ProjectHomeReader,
                    useValue: alpha.projectHomeReader,
                  },
                ]
              : []),
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
            ...(alpha.reportStore && alpha.fieldStore && alpha.checkInStore
              ? [{ provide: CheckInStore, useValue: alpha.checkInStore }]
              : []),
            ...(alpha.reportStore && alpha.fieldStore && alpha.foremanStore
              ? [{ provide: ForemanStore, useValue: alpha.foremanStore }]
              : []),
          ]
        : []),
    ],
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
      businessEntry(resolve(process.env['WEB_ROOT'])),
      publicAssets(resolve(process.env['WEB_ROOT'])),
      express.static(resolve(process.env['WEB_ROOT']), {
        dotfiles: 'deny',
        index: 'index.html',
      }),
    );
  app.useGlobalFilters(new SafeErrorFilter());
  if (options.installSignalHandlers !== false) app.enableShutdownHooks();
  return app;
}

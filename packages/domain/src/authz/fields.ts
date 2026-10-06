import type {
  PeopleWindowSummaryDto,
  SafeFrozenWeatherReference,
  ProjectStatusHistoryDto,
  ProjectManagerProjectionsDto,
  StatusCommandResultDto,
  PrimaryWorkItemResultDto,
  ReportingExpectationResultDto,
} from '@mje/contracts';
import type {
  ProjectAttentionDto,
  ProjectHomeDto,
  ProjectOverviewDto,
} from '@mje/contracts';
/**
 * ADR-0003 D2.3 / D3: every field of the report, issue and photo read DTOs mapped to a layer,
 * per projector (the same key can come from different layers: a writer's `facts` are the live
 * draft, a reader's the submitted snapshot). Tables recurse where layers differ inside a value
 * (photo coordinates). Typed against the DTOs: a missing key does not compile, and an opaque
 * value (`Record<string, unknown>`) does not compile without an explicit projector.
 * Pure data; production code does not read it.
 */
import type { PhotoDto } from '@mje/contracts';
import type {
  ReportDayReaderDto,
  ReportDayRowDto,
  ReportDayWriterDto,
  ReportLagDayDto,
  ReportPlanDto,
  ReportProjectsDto,
  ReportHomeDto,
  ReportRevisionDto,
  ReportWeatherLocationsDto,
  ReportWeatherRequestDto,
  ReportWeatherSnapshotDto,
  ReportLocationCoordinatesDto,
} from '../report-reader.js';
import type { IssueHomeDto } from '../issue-reader.js';
import type { IssueStore } from '../issue-store.js';
import type { ProjectStatusHomeDto } from '../project-status/reader.js';
import type { PhotoStore } from '../photo-store.js';
import type { ReportItemDto } from '@mje/contracts';

/**
 * structure: identity and structure (ids, dates, states a reader may see, master data, confirmed
 * plan versions); draft: OD18 draft facts (a reader never learns they exist); submitted: frozen
 * in a submitted revision; coordinates: OD20 exact positions; public-text: project public text
 * (issue titles and notes); field-writer: check-ins, foreman reports and adoptions (A6.0).
 */
export type Layer =
  | 'structure'
  | 'draft'
  | 'submitted'
  | 'coordinates'
  | 'public-text'
  | 'field-writer';

/** Projectors of opaque values: the only way such a value reaches a response. */
export type OpaqueProjector =
  /**
   * report-reader `readerSnapshot`: no field / foreman data, frozen photo fields only, and a draft
   * next-day plan's rows withheld (C20).
   */
  | 'readerSnapshot'
  /** The stored snapshot as is (writers only). */
  | 'storedSnapshot';

type Opaque<V> = [V] extends [readonly unknown[]]
  ? false
  : [V] extends [object]
    ? string extends keyof V
      ? unknown extends V[keyof V]
        ? true
        : false
      : false
    : false;
/** Opaque when any member of a union is (`Record<string, unknown> | string` included). */
type AnyOpaque<V> = true extends (V extends unknown ? Opaque<V> : never)
  ? true
  : false;
type ArrMembers<V> = Extract<NonNullable<V>, readonly unknown[]>;
type ObjMembers<V> = Exclude<
  Extract<NonNullable<V>, object>,
  readonly unknown[]
>;
/** The element types of every array member. */
type ElemOf<V> =
  ArrMembers<V> extends infer A
    ? A extends readonly (infer E)[]
      ? E
      : never
    : never;
/**
 * Whether any member of a value (each union branch on its own keys) has an opaque part anywhere
 * inside it; `true extends HasOpaque<V>` reads "some member does". Past 6 levels it answers
 * true, so a deeper value cannot be a `subtree` and must list its fields (conservative, and
 * keeps the compiler's instantiation depth bounded).
 */
export type HasOpaque<
  V,
  Depth extends unknown[] = [],
> = Depth['length'] extends 6
  ? true
  : V extends unknown
    ? Opaque<V> extends true
      ? true
      : V extends readonly (infer E)[]
        ? HasOpaque<E, [...Depth, 0]>
        : V extends object
          ? true extends {
              [K in keyof V]-?: HasOpaque<V[K], [...Depth, 0]>;
            }[keyof V]
            ? true
            : false
          : false
    : never;
/**
 * A whole value in one layer, without listing its fields: allowed only when no member has an
 * opaque part (an opaque descendant must be reached through `fields` / `items` and a projector).
 */
export interface Subtree {
  subtree: Layer;
}
type SubtreeIfClear<V> = true extends HasOpaque<V> ? never : Subtree;
/**
 * Classification is recursive and mandatory, over every union member: a value with any opaque
 * member names its projector; a value with object members lists their fields (the keys of every
 * member) and a value with arrays of objects classifies their items (every element member),
 * unless the whole value is one `subtree` layer (no opaque part in any member); only primitives
 * and arrays of primitives are a bare layer.
 */
export type FieldSpec<V> = [NonNullable<V>] extends [never]
  ? { layer: Layer }
  : AnyOpaque<NonNullable<V>> extends true
    ? { layer: Layer; projector: OpaqueProjector }
    : [ArrMembers<V>] extends [never]
      ? [ObjMembers<V>] extends [never]
        ? { layer: Layer }
        : | { layer: Layer; fields: FieldTable<ObjMembers<V>> }
          | SubtreeIfClear<V>
      : [ObjMembers<V>] extends [never]
        ? // Opaque elements (any member): each element passes the named projector.
          AnyOpaque<NonNullable<ElemOf<V>>> extends true
          ? { layer: Layer; projector: OpaqueProjector }
          : [Extract<NonNullable<ElemOf<V>>, object>] extends [never]
            ? { layer: Layer }
            : | {
                  layer: Layer;
                  items: FieldTable<Extract<NonNullable<ElemOf<V>>, object>>;
                }
              | SubtreeIfClear<V>
        : SubtreeIfClear<V>;
type KeysOf<T> = T extends unknown ? keyof T : never;
type ValueAt<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;
/** Every key of every member of T, each classified over the values the members give it. */
export type FieldTable<T> = { [K in KeysOf<T>]-?: FieldSpec<ValueAt<T, K>> };
/** A projector's output: an object, or a list of rows. */
export type Root<T> = T extends readonly (infer E)[]
  ? { items: FieldTable<E> }
  : { fields: FieldTable<T> };

type IssueListDto = Awaited<ReturnType<IssueStore['list']>>;
type IssueGetDto = Awaited<ReturnType<IssueStore['get']>>;
type IssueLagDto = Awaited<ReturnType<IssueStore['lag']>>;
type PhotoListDto = Awaited<ReturnType<PhotoStore['list']>>;
type PhotoGetDto = Awaited<ReturnType<PhotoStore['get']>>;

/** The DTO each layered projector produces. */
export interface ProjectorDtos {
  'project-status.history': ProjectStatusHistoryDto;
  'project-status.managers': ProjectManagerProjectionsDto;
  'project-status.home': ProjectStatusHomeDto;
  'project-status.ack': StatusCommandResultDto;
  'project-status.primary-ack': PrimaryWorkItemResultDto;
  'project-status.expectation-ack': ReportingExpectationResultDto;
  'report.projects': ReportProjectsDto;
  'report.home': ReportHomeDto;
  'report.days.writer': ReportDayRowDto[];
  'report.days.reader': ReportDayRowDto[];
  'report.day.writer': ReportDayWriterDto;
  'report.day.reader': ReportDayReaderDto;
  'report.revision.writer': ReportRevisionDto;
  'report.revision.reader': ReportRevisionDto;
  'report.plan.writer': ReportPlanDto;
  'report.plan.reader': ReportPlanDto;
  'report.items': ReportItemDto[];
  'report.peopleWindow': PeopleWindowSummaryDto;
  'report.weatherLocations': ReportWeatherLocationsDto;
  'report.weatherRequest': ReportWeatherRequestDto;
  'report.weatherSnapshot': ReportWeatherSnapshotDto;
  'report.reportLocationCoordinates': ReportLocationCoordinatesDto;
  'report.lagHistory': ReportLagDayDto[];
  'issue.list': IssueListDto;
  'issue.home': IssueHomeDto;
  'issue.get': IssueGetDto;
  'issue.lag': IssueLagDto;
  'project-home.home': ProjectHomeDto;
  'project-home.attention': ProjectAttentionDto;
  'project-home.overview': ProjectOverviewDto;
  'photo.list.writer': PhotoListDto;
  'photo.list.reader': PhotoListDto;
  'photo.meta.writer': PhotoGetDto;
  'photo.meta.reader': PhotoGetDto;
}
/**
 * Projectors of modules not layered yet (field, check-in, foreman, Alpha, platform): named in
 * surface.ts so every read entry has one; their field tables come with their module exits.
 */
export type UnlayeredProjector =
  | 'photo.content'
  | 'public.health'
  | 'public.authConfig'
  | 'AlphaStore.projects'
  | 'AlphaStore.list'
  | 'AlphaStore.get'
  | 'FieldStore.entryCode'
  | 'FieldStore.roster'
  | 'FieldStore.devices'
  | 'FieldStore.me'
  | 'CheckInStore.checkIns'
  | 'CheckInStore.selfie'
  | 'CheckInStore.settings'
  | 'ForemanStore.report'
  | 'system.none';
export type ProjectorName = keyof ProjectorDtos | UnlayeredProjector;

const S = { layer: 'structure' } as const;
const SUB = { layer: 'submitted' } as const;
const COORD = { layer: 'coordinates' } as const;
const FW = { layer: 'field-writer' } as const;
/** A whole object or list in one layer (no opaque part inside; checked by FieldSpec). */
const sub = (layer: Layer) => ({ subtree: layer }) as const;

/** One photo: everything structure except exact coordinates (OD20). */
const photo = (layer: Layer): FieldTable<PhotoDto> => ({
  id: S,
  projectId: S,
  businessDate: S,
  source: S,
  mediaType: S,
  sizeBytes: S,
  sha256: S,
  capture: {
    layer,
    fields: { lat: COORD, lon: COORD, accuracyM: { layer }, fixAt: { layer } },
  },
  deviceCapturedAt: { layer },
  file: {
    layer,
    fields: {
      takenLocal: { layer },
      takenAt: { layer },
      gps: sub('coordinates'),
    },
  },
  location: { layer },
  coordinates: S,
  hasThumbnail: S,
  receivedAt: S,
  uploadedByPersonId: S,
  link: sub(layer),
  linkVersion: { layer },
});
const days = (state: Layer): Root<ReportDayRowDto[]> => ({
  items: { businessDate: S, state: { layer: state }, revision: S },
});
/** The day keys both projectors share; `content` is where the day's facts come from. */
const weatherData = {
  provider: SUB,
  query: {
    layer: 'submitted',
    fields: {
      projectId: S,
      locationVersionId: S,
      businessDate: S,
      timezone: S,
      point: sub('coordinates'),
      interval: sub('structure'),
      product: S,
      model: S,
    },
  },
  category: SUB,
  fetchedAt: SUB,
  publishedAt: SUB,
  coverage: SUB,
  grid: sub('coordinates'),
  metrics: sub('submitted'),
} as const;
// Frozen site-purpose query points and provider grid cells are submitted weather provenance.
// They are never taken from the restricted personal ReportLocationRecord coordinate exit.
const frozenWeatherData = {
  ...weatherData,
  query: {
    ...weatherData.query,
    fields: { ...weatherData.query.fields, point: sub('submitted') },
  },
  grid: sub('submitted'),
} as const;
const weatherReferenceFields: FieldTable<SafeFrozenWeatherReference> = {
  referenceId: S,
  snapshotId: S,
  locationVersionId: S,
  adoptedAt: SUB,
  adoptedByAccountId: SUB,
  adoptedByPersonId: SUB,
  snapshot: { layer: 'submitted', fields: frozenWeatherData },
  adapterVersion: SUB,
  responseHash: SUB,
  sourceLink: SUB,
  licenseLink: SUB,
};
const dayCommon = (content: Layer) =>
  ({
    access: S,
    projectId: S,
    businessDate: S,
    siteTimezone: S,
    state: { layer: content },
    version: { layer: content },
    currentRevisionNumber: S,
    correctionReason: { layer: content },
    // Classify each fact explicitly: the source-cell nesting exceeds the subtree depth guard.
    facts: {
      layer: content,
      fields: {
        weather: { layer: content },
        temperature: { layer: content },
        qty: sub(content),
        cumulative: sub(content),
        narrative: sub(content),
        people: sub(content),
        presence: sub(content),
        machinery: sub(content),
        materials: sub(content),
        milestones: sub(content),
        noWork: sub(content),
        updated: sub(content),
        sourceReport: sub(content),
        weatherReferences: sub(content),
        reportLocationRef: sub(content),
      },
    },
    weatherReferences: { layer: content, items: weatherReferenceFields },
    items: sub('structure'),
    planStatus: sub(content),
    baseline: sub('structure'),
    nextPlan: sub(content),
    previousSubmittedDate: SUB,
    cumulativeBase: sub('submitted'),
    materialsCumulative: sub(content),
    issues: sub(content === 'draft' ? 'public-text' : 'submitted'),
    photos: { layer: content, items: photo(content) },
    unlinkedPhotos: { layer: content },
    coverage: sub(content),
    revisions: sub('submitted'),
  }) as const;
const revision = (projector: OpaqueProjector, layer: Layer) => ({
  fields: {
    reportRevisionId: S,
    n: S,
    at: S,
    by: S,
    reason: SUB,
    snapshot: { layer, projector },
  },
});
const plan = (live: Layer): Root<ReportPlanDto> => ({
  fields: {
    targetBusinessDate: S,
    status: sub(live),
    rows: sub(live),
    draft: sub(live),
    versions: sub('structure'),
  },
});
const photoList = (layer: Layer): Root<PhotoListDto> => ({
  fields: {
    access: S,
    projectId: S,
    businessDate: S,
    photos: { layer, items: photo(layer) },
    unlinkedPhotos: { layer },
  },
});
const photoMeta = (layer: Layer): Root<PhotoGetDto> => ({
  fields: { access: S, photo: { layer, fields: photo(layer) } },
});

const reportItemFields = {
  kind: S,
  key: S,
  label: S,
  unit: S,
  designQty: S,
  openingCumulative: S,
  plannedDate: S,
  sortOrder: S,
  active: S,
};

export const FIELDS: { [P in keyof ProjectorDtos]: Root<ProjectorDtos[P]> } = {
  'project-status.managers': {
    items: { projectId: S, personId: S, displayName: { layer: 'public-text' } },
  },
  'project-status.home': {
    fields: {
      projects: {
        layer: 'structure',
        items: {
          projectId: S,
          expectationDueDates: {
            layer: 'structure',
            items: { businessDate: S, cutoff: S },
          },
          latest: {
            layer: 'structure',
            fields: {
              id: S,
              n: S,
              status: S,
              previousStatus: S,
              needsSupport: S,
              supportNote: { layer: 'public-text' },
              declaredAt: S,
              businessDate: S,
              siteTimezone: S,
            },
          },
          recent: {
            layer: 'structure',
            items: {
              id: S,
              n: S,
              status: S,
              previousStatus: S,
              needsSupport: S,
              supportNote: { layer: 'public-text' },
              declaredAt: S,
              businessDate: S,
              siteTimezone: S,
            },
          },
          previousStatus: S,
        },
      },
    },
  },
  'project-status.history': {
    fields: {
      projectId: S,
      currentN: S,
      updates: {
        layer: 'structure',
        items: {
          id: S,
          n: S,
          status: S,
          areas: S,
          situation: { layer: 'public-text' },
          recovery: { layer: 'public-text' },
          expectedRecoveryDate: S,
          expectedRecoveryUnknown: S,
          needsSupport: S,
          supportNote: { layer: 'public-text' },
          declaredAt: S,
          siteTimezone: S,
          businessDate: S,
          declaredBy: S,
          declaredByPersonId: S,
          notes: {
            layer: 'structure',
            items: {
              id: S,
              text: { layer: 'public-text' },
              byAccountId: S,
              byPersonId: S,
              at: S,
            },
          },
        },
      },
    },
  },
  'project-status.ack': {
    fields: { projectId: S, n: S, statusUpdateId: S, noteId: S },
  },

  'project-status.primary-ack': {
    fields: { projectId: S, key: S, version: S },
  },
  'project-status.expectation-ack': {
    fields: { projectId: S, expectationId: S, n: S, registeredAt: S },
  },
  'report.projects': {
    fields: { accountId: S, personId: S, projects: sub('structure') },
  },
  'report.home': {
    fields: {
      projects: {
        layer: 'structure',
        items: {
          id: S,
          name: S,
          code: S,
          timezone: S,
          region: S,
          projectType: S,
          primaryWorkItemKey: S,
          today: S,
          access: S,
          items: { layer: 'structure', items: reportItemFields },
          snapshots: {
            layer: 'submitted',
            items: {
              businessDate: S,
              submittedAt: S,
              firstSubmittedAt: S,
              primaryWorkItemKey: S,
              baseline: sub('submitted'),
              items: { layer: 'submitted', items: reportItemFields },
              milestones: sub('submitted'),
              facts: {
                layer: 'submitted',
                fields: {
                  qty: sub('submitted'),
                  cumulative: sub('submitted'),
                  cumulativeCarry: sub('submitted'),
                  people: sub('submitted'),
                  milestones: sub('submitted'),
                },
              },
            },
          },
          reportDays: {
            layer: 'structure',
            items: { businessDate: S, submitted: S },
          },
        },
      },
    },
  },
  'report.days.writer': days('draft'),
  'report.days.reader': days('submitted'),
  'report.day.writer': {
    fields: {
      ...dayCommon('draft'),
      foreman: {
        layer: 'field-writer',
        fields: {
          rosterVersion: FW,
          expectedCrews: sub('field-writer'),
          revisions: sub('field-writer'),
          items: sub('field-writer'),
          adoptions: sub('field-writer'),
          basis: sub('field-writer'),
          submittedExpectedCrews: FW,
          expectedCrewsChanged: FW,
        },
      },
    },
  },
  'report.day.reader': { fields: dayCommon('submitted') },
  'report.revision.writer': revision('storedSnapshot', 'submitted'),
  'report.revision.reader': revision('readerSnapshot', 'submitted'),
  'report.weatherLocations': {
    items: {
      id: S,
      projectId: S,
      scopeKey: S,
      n: S,
      siteTimezone: S,
      point: sub('coordinates'),
      confirmedAt: S,
    },
  },
  'report.weatherRequest': {
    fields: {
      id: S,
      projectId: S,
      businessDate: S,
      locationVersionId: S,
      state: { layer: 'draft' },
      snapshotId: S,
    },
  },
  'report.weatherSnapshot': {
    fields: {
      id: S,
      data: { layer: 'submitted', fields: weatherData },
      adapterVersion: SUB,
      responseHash: SUB,
      sourceLink: SUB,
      licenseLink: SUB,
    },
  },
  'report.reportLocationCoordinates': {
    fields: { lat: { layer: 'coordinates' }, lon: { layer: 'coordinates' } },
  },
  'report.peopleWindow': {
    fields: {
      schemaVersion: S,
      projectId: S,
      windowFrom: S,
      windowTo: S,
      basis: S,
      policyVersion: S,
      selectedAtUTC: S,
      dayContributions: sub('submitted'),
      categoryKnownSubtotals: sub('submitted'),
      reportedDays: SUB,
      slotDays: S,
      totalState: SUB,
    },
  },
  'report.plan.writer': plan('draft'),
  'report.plan.reader': plan('structure'),
  'report.items': {
    items: reportItemFields,
  },
  'report.lagHistory': {
    items: {
      businessDate: S,
      baseline: sub('structure'),
      qty: sub('submitted'),
    },
  },
  'issue.list': {
    fields: {
      access: S,
      projectId: S,
      businessDate: S,
      issues: sub('public-text'),
    },
  },
  'issue.home': {
    fields: {
      projects: {
        layer: 'structure',
        items: {
          projectId: S,
          lagOpenKeys: { layer: 'structure' },
          lagDismissedKeys: { layer: 'structure' },
          issues: {
            layer: 'public-text',
            items: {
              id: S,
              title: { layer: 'public-text' },
              category: S,
              createdOn: S,
              dueOn: S,
              state: S,
              workItemKey: S,
              escalate: S,
              attentionAt: S,
            },
          },
        },
      },
    },
  },
  'issue.get': {
    fields: { access: S, issue: sub('public-text') },
  },
  'project-home.home': {
    fields: {
      groupBy: S,
      page: S,
      size: S,
      total: S,
      counts: {
        layer: 'structure',
        fields: {
          OFF_TRACK: S,
          AT_RISK: S,
          STALE: S,
          PAUSED: S,
          UNDECLARED: S,
          NORMAL: S,
        },
      },
      groups: {
        layer: 'structure',
        items: {
          key: S,
          count: S,
          projects: {
            layer: 'structure',
            items: {
              id: S,
              code: S,
              name: S,
              timezone: S,
              region: S,
              projectType: S,
              managers: {
                layer: 'structure',
                items: { personId: S, displayName: { layer: 'public-text' } },
              },
              status: {
                layer: 'structure',
                fields: {
                  value: S,
                  declaredStatus: S,
                  declaredAt: S,
                  businessDate: S,
                  staleDays: S,
                },
              },
              completion: sub('submitted'),
              forecast: sub('submitted'),
              hints: {
                layer: 'submitted',
                items: { code: S, count: S, expectedDate: S },
              },
              reportsLast7: {
                layer: 'structure',
                items: { businessDate: S, submitted: S },
              },
            },
          },
        },
      },
    },
  },
  'project-home.attention': {
    fields: {
      items: {
        layer: 'public-text',
        items: {
          kind: S,
          id: S,
          projectId: S,
          projectCode: S,
          projectName: S,
          title: { layer: 'public-text' },
          at: S,
        },
      },
    },
  },
  'project-home.overview': {
    fields: {
      projectId: S,
      projectCode: S,
      projectName: S,
      timezone: S,
      statusHistory: {
        layer: 'structure',
        fields: {
          projectId: S,
          currentN: S,
          updates: {
            layer: 'public-text',
            items: {
              id: S,
              n: S,
              status: S,
              areas: S,
              situation: { layer: 'public-text' },
              recovery: { layer: 'public-text' },
              expectedRecoveryDate: S,
              expectedRecoveryUnknown: S,
              needsSupport: S,
              supportNote: { layer: 'public-text' },
              declaredAt: S,
              siteTimezone: S,
              businessDate: S,
              declaredBy: S,
              declaredByPersonId: S,
              notes: {
                layer: 'public-text',
                items: {
                  id: S,
                  text: { layer: 'public-text' },
                  byAccountId: S,
                  byPersonId: S,
                  at: S,
                },
              },
            },
          },
        },
      },
      cumulative: {
        layer: 'submitted',
        items: { businessDate: S, value: S, workItemKey: S, unit: S },
      },
      primaryWorkItem: {
        layer: 'submitted',
        fields: {
          key: S,
          label: S,
          unit: S,
          designQty: S,
          completion: sub('submitted'),
          forecast: sub('submitted'),
          plannedDate: S,
        },
      },
      workItems: {
        layer: 'structure',
        items: {
          kind: S,
          key: S,
          label: S,
          unit: S,
          designQty: S,
          openingCumulative: S,
          sortOrder: S,
          active: S,
          plannedDate: S,
        },
      },
      milestones: {
        layer: 'submitted',
        items: {
          id: S,
          key: S,
          label: S,
          plannedDate: S,
          actual: S,
          active: S,
        },
      },
      peopleLast7: {
        layer: 'submitted',
        items: { businessDate: S, categories: sub('submitted') },
      },
      openIssues: {
        layer: 'public-text',
        items: {
          id: S,
          title: { layer: 'public-text' },
          category: S,
          createdOn: S,
          dueOn: S,
          state: S,
        },
      },
    },
  },
  'issue.lag': {
    fields: { projectId: S, businessDate: S, suggestions: sub('submitted') },
  },
  'photo.list.writer': photoList('draft'),
  'photo.list.reader': photoList('submitted'),
  'photo.meta.writer': photoMeta('draft'),
  'photo.meta.reader': photoMeta('submitted'),
};

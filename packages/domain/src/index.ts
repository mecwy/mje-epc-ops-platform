export * from './alpha-store.js';
export * from './report-rules.js';
export {
  READ_ROLES,
  REPORT_SCOPE,
  ReportError,
  ReportStore,
  WRITE_ROLES,
  type DayState,
  type ReportCoverage,
  type ReportProjectRow,
} from './report-store.js';
// The report module exit (ADR-0003 D2): the only way to report data outside the module.
export {
  reportReader,
  type ReportReadContext,
  type ReportReadView,
} from './report-reader.js';
export * from './issue-store.js';
export type { Access, Actor } from './store-kit.js';
export { RETRY_SQLSTATES } from './store-kit.js';
export * from './photo-file.js';
export * from './photo-store.js';
export * from './photo-strip.js';
export * from './field-rules.js';
export {
  FieldError,
  FieldThrottle,
  advanceClock,
  clearPreviousHash,
  hashSecret,
  persistObservedExpiry,
  recordActivity,
  type FieldErrorCode,
} from './field-kit.js';
export * from './field-store.js';
export * from './checkin-rules.js';
export * from './checkin-store.js';
export * from './foreman-store.js';

export { ProjectStatusCommands } from './project-status/commands.js';
export {
  ProjectStatusReader,
  projectStatusReader,
} from './project-status/reader.js';
export { ProjectStatusError } from './project-status/rules.js';
export {
  ProjectHomeReader,
  observeProjectHomeProjections,
  PROJECT_HOME_PROJECTORS,
} from './project-home/reader.js';
export {
  aggregateProjectAttention,
  aggregateProjectHome,
} from './project-home/aggregate.js';
export {
  completion as projectHomeCompletion,
  forecastCompletion as projectHomeForecastCompletion,
  statusAge as projectHomeStatusAge,
} from './project-home/rules.js';
export type {
  Completion as ProjectHomeCompletion,
  Forecast as ProjectHomeForecast,
  ForecastObservation as ProjectHomeForecastObservation,
} from './project-home/rules.js';

export { ContractRegisterReader } from './contract-register/reader.js';
export { ContractRegisterError } from './contract-register/rules.js';

export { ContractRegisterCommands } from './contract-register/commands.js';
export { OpportunityCommands } from './opportunity/commands.js';
export { OpportunityReader } from './opportunity/reader.js';
export { OpportunityError } from './opportunity/rules.js';
export * from './manager-review-rules.js';

export { WeatherStore, WeatherStoreError } from './weather-store.js';
export {
  createMetForecastCacheGate,
  MetForecastCacheError,
} from './met-forecast-cache.js';
export type {
  MetCacheEntry,
  MetCacheLease,
  MetSharedGate,
} from './met-forecast-cache.js';
export {
  claimWeatherJob,
  finishWeatherJob,
  failWeatherJob,
  deferWeatherJob,
} from './weather-jobs.js';
export type {
  WeatherJobLease,
  WeatherJobFailure,
  WeatherSnapshotMetadata,
} from './weather-jobs.js';

export {
  ManagerReviewStore,
  DENY_REVIEW_PORTS,
} from './manager-review-store.js';
export type { ReviewServerPorts } from './manager-review-store.js';
export { ManagerReviewError } from './manager-review-reader.js';
export {
  BusinessEvidenceStore,
  BusinessEvidenceError,
  deniedBusinessEvidencePorts,
} from './business-evidence-store.js';
export type { BusinessEvidencePorts } from './business-evidence-store.js';
export { BusinessEvidenceReader } from './business-evidence-reader.js';
export type { BusinessEvidenceReadPorts } from './business-evidence-reader.js';

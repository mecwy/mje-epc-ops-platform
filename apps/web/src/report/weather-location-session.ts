import { ReadFence } from '../read-fence.js';
import { MAX_LOCATE_MS } from './geo.js';
import type {
  MetForecastDto,
  WeatherLocationDto,
  WeatherRequestCommand,
  WeatherRequestState,
} from '@mje/contracts';

/** Presentation adapters only. Parent DayStore owns all persistence and command retries. */
export interface WeatherContext {
  ownerKey: string;
  projectId: string;
  businessDate: string;
  timezone: string;
  locationVersionId: string | null;
}
export interface LocationCandidate {
  lat: string;
  lon: string;
  accuracyM: string;
  deviceFixAt: string | null;
  acquiredAt: string;
}
export type WeatherReferenceView = {
  projectId: string;
  businessDate: string;
  timezone: string;
  locationVersionId: string;
  snapshotId: string;
  sourceLink?: string;
  licenseLink?: string;
  category: 'reanalysis' | 'analysis' | 'forecast';
  fetchedAt: string;
  publishedAt: string | null;
  interval: { startAt: string; endAt: string };
  coverage: 'complete' | 'partial';
  stale: boolean;
  values: {
    label: string;
    state: 'value' | 'blank' | 'missing' | 'unknown' | 'not_applicable';
    value: string | null;
    unit: string | null;
  }[];
} & (
  | { source: 'met-norway'; forecast: MetForecastDto }
  | { source: 'open-meteo' | 'TEST Open-Meteo'; forecast?: never }
);
export type LocateInput =
  | { kind: 'fix'; reading: unknown }
  | { kind: 'denied' | 'unsupported' | 'unavailable' };
/** Retained by this workspace/day session; unknown POST retries use this exact command. */
export interface WeatherQueryIntent {
  command: WeatherRequestCommand;
  requestId?: string;
}
export type WeatherQueryResult =
  | { kind: 'ready'; reference: WeatherReferenceView }
  | { kind: 'pending' }
  | {
      kind: 'terminal';
      state: Exclude<WeatherRequestState, 'READY' | 'PENDING' | 'FETCHING'>;
    }
  | { kind: 'unknown' };
export interface WeatherLocationDependencies {
  listLocations?: (
    context: Readonly<WeatherContext>,
    signal: AbortSignal,
  ) => Promise<WeatherLocationDto[]>;
  queryWeather?: (
    context: Readonly<WeatherContext>,
    intent: WeatherQueryIntent,
    signal: AbortSignal,
  ) => Promise<WeatherQueryResult>;
  loadWeather: (
    context: Readonly<WeatherContext>,
    signal: AbortSignal,
  ) => Promise<WeatherReferenceView>;
  locate: (signal: AbortSignal) => Promise<LocateInput>;
  /** Bind the authoritative location codec once its shared export is admitted. */
  acceptLocation: (input: unknown) => LocationCandidate;
  /** Accept into the parent draft; true means pending save, never server persistence. */
  confirmLocation: (
    context: Readonly<WeatherContext>,
    candidate: Readonly<LocationCandidate>,
  ) => boolean;
  referenceWeather: (
    context: Readonly<WeatherContext>,
    snapshotId: string,
  ) => boolean;
}
export interface WeatherLocationState {
  context: WeatherContext;
  writable: boolean;
  locked: boolean;
  weatherStatus:
    | 'not_configured'
    | 'idle'
    | 'loading'
    | 'ready'
    | 'unavailable'
    | 'pending'
    | 'unknown'
    | 'NO_HISTORY'
    | 'UNAVAILABLE'
    | 'RATE_LIMITED'
    | 'DISABLED';
  locationDirectoryStatus:
    'idle' | 'loading' | 'none' | 'choose' | 'selected' | 'failed';
  locations: WeatherLocationDto[];
  locationUpdated: boolean;
  reference: WeatherReferenceView | null;
  referencedSnapshotId: string | null;
  locating: boolean;
  locationStatus:
    | 'idle'
    | 'candidate'
    | 'denied'
    | 'unsupported'
    | 'unavailable'
    | 'confirmed_pending_save';
  candidate: LocationCandidate | null;
}
const keyOf = (c: WeatherContext) =>
  JSON.stringify([
    c.ownerKey,
    c.projectId,
    c.businessDate,
    c.timezone,
    c.locationVersionId,
  ]);

export class WeatherLocationSession {
  private state: WeatherLocationState;
  private weatherFence = new ReadFence();
  private locationFence = new ReadFence();
  private weatherController: AbortController | null = null;
  private locationController: AbortController | null = null;
  private directoryController: AbortController | null = null;
  private directoryFence = new ReadFence();
  private queryIntent: WeatherQueryIntent | null = null;
  private listeners = new Set<() => void>();

  constructor(
    context: WeatherContext,
    private readonly dependencies: WeatherLocationDependencies,
    access: { writable: boolean; locked: boolean },
  ) {
    this.state = {
      context: structuredClone(context),
      ...access,
      weatherStatus: context.locationVersionId ? 'idle' : 'not_configured',
      locationDirectoryStatus: 'idle',
      locations: [],
      locationUpdated: false,
      reference: null,
      referencedSnapshotId: null,
      locating: false,
      locationStatus: 'idle',
      candidate: null,
    };
  }
  getSnapshot = (): WeatherLocationState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<WeatherLocationState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  get editable() {
    return this.state.writable && !this.state.locked;
  }
  /** The parent calls this only after its positively applied post-write day read. */
  acknowledgeSavedIntent() {
    if (this.state.locationStatus === 'confirmed_pending_save')
      this.update({ locationStatus: 'idle' });
    if (this.state.referencedSnapshotId)
      this.update({ referencedSnapshotId: null });
  }
  setContext(context: WeatherContext) {
    if (keyOf(context) === keyOf(this.state.context)) return;
    const changedOwner =
      context.ownerKey !== this.state.context.ownerKey ||
      context.projectId !== this.state.context.projectId ||
      context.businessDate !== this.state.context.businessDate ||
      context.timezone !== this.state.context.timezone;
    this.deactivate();
    this.queryIntent = null;
    this.update({
      context: structuredClone(context),
      reference: null,
      referencedSnapshotId: null,
      candidate: null,
      locationStatus: 'idle',
      weatherStatus: context.locationVersionId ? 'idle' : 'not_configured',
      ...(changedOwner
        ? {
            locations: [],
            locationDirectoryStatus: 'idle' as const,
            locationUpdated: false,
          }
        : {}),
    });
  }
  setAccess(access: { writable: boolean; locked: boolean }) {
    if (!access.writable || access.locked) this.cancelLocation();
    if (!access.writable || access.locked) {
      this.cancelWeather();
      this.cancelDirectory();
    }
    this.update(access);
  }
  private cancelWeather() {
    this.weatherController?.abort();
    this.weatherController = null;
    this.weatherFence.supersedeAll();
    if (this.state.weatherStatus === 'loading')
      this.update({
        weatherStatus: this.state.reference
          ? 'ready'
          : this.state.context.locationVersionId
            ? 'idle'
            : 'not_configured',
      });
  }
  cancelLocation = () => {
    this.locationController?.abort();
    this.locationController = null;
    this.locationFence.supersedeAll();
    this.update({ locating: false, candidate: null, locationStatus: 'idle' });
  };
  /** Called when the panel leaves view; does not touch parent facts or saved references. */
  deactivate = () => {
    this.cancelWeather();
    this.cancelLocation();
    this.cancelDirectory();
  };

  private cancelDirectory() {
    this.directoryController?.abort();
    this.directoryController = null;
    this.directoryFence.supersedeAll();
    if (this.state.locationDirectoryStatus === 'loading')
      this.update({ locationDirectoryStatus: 'idle' });
  }
  /** One activation owner calls this after access is applied; reactivation rechecks the directory. */
  async activateWeather(refresh = false): Promise<boolean> {
    if (!this.editable) return false;
    if (!this.dependencies.listLocations) return this.refreshWeather();
    if (this.directoryController) return false;
    this.cancelWeather();
    const controller = new AbortController();
    this.directoryController = controller;
    const ticket = this.directoryFence.begin();
    const context = structuredClone(this.state.context);
    const previous = this.state.locations.find(
      (location) => location.id === context.locationVersionId,
    );
    this.update({
      locationDirectoryStatus: 'loading',
      reference: this.state.reference
        ? { ...this.state.reference, stale: true }
        : null,
    });
    try {
      const locations = await this.dependencies.listLocations(
        context,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        !this.directoryFence.current(ticket) ||
        !this.editable
      )
        return false;
      this.directoryFence.settle(ticket, true);
      // A previously selected scope remains deliberate; its latest version supersedes the old one.
      const selected = previous
        ? locations.find((location) => location.scopeKey === previous.scopeKey)
        : locations.length === 1
          ? locations[0]
          : undefined;
      const changed = (selected?.id ?? null) !== context.locationVersionId;
      if (changed)
        this.setContext({
          ...context,
          locationVersionId: selected?.id ?? null,
        });
      this.update({
        locations,
        locationDirectoryStatus: !locations.length
          ? 'none'
          : selected
            ? 'selected'
            : 'choose',
        locationUpdated:
          !!previous && !!selected && previous.id !== selected.id,
      });
      if (!selected) return false;
      return this.runWeather(refresh);
    } catch {
      if (controller.signal.aborted || !this.directoryFence.current(ticket))
        return false;
      this.directoryFence.settle(ticket, false);
      this.update({
        locationDirectoryStatus: 'failed',
        weatherStatus: 'unavailable',
      });
      return false;
    } finally {
      if (this.directoryController === controller)
        this.directoryController = null;
    }
  }
  async selectWeatherLocation(locationVersionId: string): Promise<boolean> {
    if (!this.editable || this.state.locationDirectoryStatus === 'loading')
      return false;
    const location = this.state.locations.find(
      (item) => item.id === locationVersionId,
    );
    if (!location) return false;
    if (this.state.context.locationVersionId === location.id) return false;
    this.setContext({ ...this.state.context, locationVersionId: location.id });
    this.update({
      locationDirectoryStatus: 'selected',
      locationUpdated: false,
    });
    return this.runWeather(false);
  }

  async refreshWeather(): Promise<boolean> {
    // Explicit refresh rechecks confirmed scopes before creating a new provider command.
    if (this.dependencies.listLocations) {
      if (
        [
          'ready',
          'NO_HISTORY',
          'UNAVAILABLE',
          'RATE_LIMITED',
          'DISABLED',
        ].includes(this.state.weatherStatus) ||
        (this.state.weatherStatus === 'unavailable' &&
          !!this.queryIntent?.requestId)
      )
        this.queryIntent = null;
      return this.activateWeather(true);
    }
    return this.runWeather(true);
  }
  private async runWeather(refresh: boolean): Promise<boolean> {
    if (!this.editable || !this.state.context.locationVersionId) return false;
    this.cancelWeather();
    const controller = new AbortController();
    this.weatherController = controller;
    const ticket = this.weatherFence.begin();
    const context = structuredClone(this.state.context);
    this.update({
      weatherStatus: 'loading',
      reference: this.state.reference
        ? { ...this.state.reference, stale: true }
        : null,
    });
    try {
      let reference: WeatherReferenceView;
      if (this.dependencies.queryWeather) {
        if (!this.queryIntent)
          this.queryIntent = {
            command: {
              projectId: context.projectId,
              locationVersionId: context.locationVersionId!,
              businessDate: context.businessDate,
              refresh,
              clientMutationId: crypto.randomUUID(),
            },
          };
        const result = await this.dependencies.queryWeather(
          context,
          this.queryIntent,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          !this.weatherFence.current(ticket) ||
          !this.editable
        )
          return false;
        if (result.kind !== 'ready') {
          this.weatherFence.settle(ticket, true);
          this.update({
            weatherStatus:
              result.kind === 'terminal' ? result.state : result.kind,
            reference: this.state.reference
              ? { ...this.state.reference, stale: true }
              : null,
          });
          return false;
        }
        reference = result.reference;
      } else
        reference = await this.dependencies.loadWeather(
          context,
          controller.signal,
        );
      if (controller.signal.aborted || !this.weatherFence.current(ticket))
        return false;
      // A server/adapter mismatch is fail-visible; no reference from another day is adopted.
      if (
        reference.projectId !== context.projectId ||
        reference.businessDate !== context.businessDate ||
        reference.timezone !== context.timezone ||
        reference.locationVersionId !== context.locationVersionId
      )
        throw new Error('WEATHER_CONTEXT_MISMATCH');
      this.weatherFence.settle(ticket, true);
      this.update({
        reference: structuredClone(reference),
        weatherStatus: 'ready',
      });
      return true;
    } catch {
      if (controller.signal.aborted || !this.weatherFence.current(ticket))
        return false;
      this.weatherFence.settle(ticket, false);
      this.update({
        weatherStatus: 'unavailable',
        reference: this.state.reference
          ? { ...this.state.reference, stale: true }
          : null,
      });
      return false;
    } finally {
      if (this.weatherController === controller) this.weatherController = null;
    }
  }
  async captureLocation(): Promise<boolean> {
    if (!this.editable || this.state.locating) return false;
    this.cancelLocation();
    const controller = new AbortController();
    this.locationController = controller;
    const ticket = this.locationFence.begin();
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.update({ locating: true });
    try {
      const result = await Promise.race([
        this.dependencies.locate(controller.signal),
        new Promise<LocateInput>((resolve) => {
          timer = setTimeout(() => {
            resolve({ kind: 'unavailable' });
          }, MAX_LOCATE_MS);
        }),
      ]);
      if (controller.signal.aborted || !this.locationFence.current(ticket))
        return false;
      if (result.kind !== 'fix') {
        this.locationFence.settle(ticket, true);
        this.update({
          locating: false,
          locationStatus: result.kind,
          candidate: null,
        });
        return false;
      }
      const candidate = this.dependencies.acceptLocation(result.reading);
      this.locationFence.settle(ticket, true);
      this.update({
        locating: false,
        candidate: structuredClone(candidate),
        locationStatus: 'candidate',
      });
      return true;
    } catch {
      if (controller.signal.aborted || !this.locationFence.current(ticket))
        return false;
      this.locationFence.settle(ticket, false);
      this.update({
        locating: false,
        candidate: null,
        locationStatus: 'unavailable',
      });
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      if (this.locationController === controller)
        this.locationController = null;
    }
  }
  confirmLocation(): boolean {
    if (
      !this.editable ||
      this.state.locationStatus !== 'candidate' ||
      !this.state.candidate
    )
      return false;
    try {
      const accepted = this.dependencies.confirmLocation(
        structuredClone(this.state.context),
        structuredClone(this.state.candidate),
      );
      if (!accepted) return false;
      this.update({
        candidate: null,
        locationStatus: 'confirmed_pending_save',
      });
      return true;
    } catch {
      // Preserve the candidate so a parent lock/failure cannot consume the user's input.
      return false;
    }
  }
  referenceWeather(): boolean {
    const ref = this.state.reference;
    if (
      ref &&
      this.dependencies.queryWeather &&
      (Date.now() - Date.parse(ref.fetchedAt) >= 3600000 ||
        (ref.source === 'met-norway' &&
          Date.now() >= Date.parse(ref.forecast.coveredInterval.endAt)))
    ) {
      this.update({ reference: { ...ref, stale: true } });
      return false;
    }
    if (
      !this.editable ||
      !ref ||
      this.state.weatherStatus !== 'ready' ||
      this.state.referencedSnapshotId === ref.snapshotId ||
      ref.stale
    )
      return false;
    try {
      if (
        !this.dependencies.referenceWeather(
          structuredClone(this.state.context),
          ref.snapshotId,
        )
      )
        return false;
      this.update({ referencedSnapshotId: ref.snapshotId });
      return true;
    } catch {
      return false;
    }
  }
}

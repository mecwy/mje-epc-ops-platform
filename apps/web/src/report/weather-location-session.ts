import { ReadFence } from '../read-fence.js';
import { MAX_LOCATE_MS } from './geo.js';

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
export interface WeatherReferenceView {
  projectId: string;
  businessDate: string;
  timezone: string;
  locationVersionId: string;
  snapshotId: string;
  source: string;
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
}
export type LocateInput =
  | { kind: 'fix'; reading: unknown }
  | { kind: 'denied' | 'unsupported' | 'unavailable' };
export interface WeatherLocationDependencies {
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
    'not_configured' | 'idle' | 'loading' | 'ready' | 'unavailable';
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
  setContext(context: WeatherContext) {
    if (keyOf(context) === keyOf(this.state.context)) return;
    this.deactivate();
    this.update({
      context: structuredClone(context),
      reference: null,
      referencedSnapshotId: null,
      candidate: null,
      locationStatus: 'idle',
      weatherStatus: context.locationVersionId ? 'idle' : 'not_configured',
    });
  }
  setAccess(access: { writable: boolean; locked: boolean }) {
    if (!access.writable || access.locked) this.cancelLocation();
    if (!access.writable) this.cancelWeather();
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
  };

  async refreshWeather(): Promise<boolean> {
    if (!this.editable || !this.state.context.locationVersionId) return false;
    this.cancelWeather();
    const controller = new AbortController();
    this.weatherController = controller;
    const ticket = this.weatherFence.begin();
    const context = structuredClone(this.state.context);
    this.update({ weatherStatus: 'loading' });
    try {
      const reference = await this.dependencies.loadWeather(
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
      this.update({ weatherStatus: 'unavailable' });
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
      !this.editable ||
      !ref ||
      this.state.weatherStatus !== 'ready' ||
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

import type { CaptureFixDto } from '@mje/contracts';

/** Stop refreshing once a fix is this good (metres). */
export const GOOD_ACCURACY_M = 30;
/** Never refresh longer than this. */
export const MAX_LOCATE_MS = 8000;

/** Why no fix was obtained; each gets its own message and a retry. */
export type NoFixReason = 'unsupported' | 'denied' | 'noFix';
export type LocateResult =
  { fix: CaptureFixDto; reason: null } | { fix: null; reason: NoFixReason };

/** The part of the Geolocation API used here (injected so tests can drive it). */
export interface GeoSource {
  watchPosition(
    success: (p: {
      coords: { latitude: number; longitude: number; accuracy: number };
      timestamp: number;
    }) => void,
    error: (e: { code: number }) => void,
    options: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}
const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};
const PERMISSION_DENIED = 1;

/**
 * A position as the contract takes it: decimal strings at the stored precision (6 decimals
 * for degrees, 2 for the accuracy radius) and the time the device fixed it. A reading the
 * contract cannot represent is not a fix; it is never clamped into one.
 */
export function toFix(
  coords: { latitude: number; longitude: number; accuracy: number },
  timestamp: number,
  now: number,
): CaptureFixDto | null {
  const { latitude, longitude, accuracy } = coords;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(accuracy) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    accuracy < 0 ||
    accuracy > 999999.99
  )
    return null;
  // Some browsers report 0 or nonsense; then the fix time is when it arrived.
  const at = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : now;
  return {
    lat: latitude.toFixed(6),
    lon: longitude.toFixed(6),
    accuracyM: accuracy.toFixed(2),
    fixAt: new Date(at).toISOString(),
  };
}

/**
 * U2.1 rule 8: ask for a fix and keep refreshing for up to MAX_LOCATE_MS, stopping early once
 * accuracy is within GOOD_ACCURACY_M; keep the best (smallest radius) fix and its time. The
 * first fix is often coarse, so the first answer is not taken as final. Permission refused
 * ends at once; otherwise errors are waited out until the limit.
 */
export function locate(
  geo: GeoSource | null | undefined,
  timers: Timers = browserTimers,
): Promise<LocateResult> {
  return new Promise((resolve) => {
    if (!geo) return resolve({ fix: null, reason: 'unsupported' });
    let best: CaptureFixDto | null = null;
    let bestAcc = Infinity;
    let done = false;
    let watch: number | null = null;
    let timer: unknown = null;
    const finish = (denied = false) => {
      if (done) return;
      done = true;
      if (watch !== null) geo.clearWatch(watch);
      if (timer !== null) timers.clear(timer);
      resolve(
        best
          ? { fix: best, reason: null }
          : { fix: null, reason: denied ? 'denied' : 'noFix' },
      );
    };
    timer = timers.set(() => finish(), MAX_LOCATE_MS);
    try {
      watch = geo.watchPosition(
        (p) => {
          if (done) return;
          const fix = toFix(p.coords, p.timestamp, timers.now());
          if (!fix) return;
          if (p.coords.accuracy < bestAcc) {
            best = fix;
            bestAcc = p.coords.accuracy;
          }
          if (bestAcc <= GOOD_ACCURACY_M) finish();
        },
        (e) => {
          if (e.code === PERMISSION_DENIED) finish(true);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: MAX_LOCATE_MS },
      );
      // A success delivered synchronously may already have finished.
      if (done && watch !== null) geo.clearWatch(watch);
    } catch {
      finish();
    }
  });
}

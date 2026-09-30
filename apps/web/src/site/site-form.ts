import {
  PM_PROXY_DAYS_MAX,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  type FieldDeviceDto,
} from '@mje/contracts';

/** Degrees as the contract stores them: up to 3 integer digits and 6 decimals. */
const COORD = /^-?\d{1,3}(\.\d{1,6})?$/;

export interface SiteInput {
  lat: string;
  lon: string;
  radius: string;
}
export type SiteField = 'lat' | 'lon' | 'radius';
export type SiteProblem = 'required' | 'format' | 'range' | 'decimals';
export type SiteCheck =
  | { ok: true; lat: string; lon: string; radiusM: number }
  | { ok: false; problems: Partial<Record<SiteField, SiteProblem>> };

/** A comma as decimal point is read as a point; nothing else is changed or rounded. */
const clean = (s: string) => s.trim().replace(',', '.');

function coordinate(raw: string, limit: number): SiteProblem | null {
  const s = clean(raw);
  if (!s) return 'required';
  if (/^-?\d{1,3}\.\d{7,}$/.test(s)) return 'decimals';
  if (!COORD.test(s)) return 'format';
  return Math.abs(Number(s)) <= limit ? null : 'range';
}

/**
 * The PM's site-location form (design §3, U2): latitude and longitude as typed (never
 * rounded; more than 6 decimals is refused, not cut) and a whole radius of 50–2000 m.
 */
export function checkSite(input: SiteInput): SiteCheck {
  const problems: Partial<Record<SiteField, SiteProblem>> = {};
  const lat = coordinate(input.lat, 90);
  const lon = coordinate(input.lon, 180);
  if (lat) problems.lat = lat;
  if (lon) problems.lon = lon;
  const r = input.radius.trim();
  if (!r) problems.radius = 'required';
  else if (!/^\d{1,4}$/.test(r)) problems.radius = 'format';
  else if (Number(r) < RADIUS_MIN_M || Number(r) > RADIUS_MAX_M)
    problems.radius = 'range';
  if (Object.keys(problems).length) return { ok: false, problems };
  return {
    ok: true,
    lat: clean(input.lat),
    lon: clean(input.lon),
    radiusM: Number(r),
  };
}

/** How many days back a PM proxy may go: a whole number 1–30. */
export function checkProxyDays(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= PM_PROXY_DAYS_MAX ? n : null;
}

export interface DeviceGroups {
  pending: FieldDeviceDto[];
  active: FieldDeviceDto[];
  ended: FieldDeviceDto[];
}
/**
 * The PM device list by the state the timestamps imply now (an unobserved expiry already
 * shows as ended), pending first. Order within a group is the server's (newest first).
 */
export function groupDevices(devices: readonly FieldDeviceDto[]): DeviceGroups {
  const g: DeviceGroups = { pending: [], active: [], ended: [] };
  for (const d of devices)
    (d.effectiveState === 'PENDING'
      ? g.pending
      : d.effectiveState === 'CONFIRMED'
        ? g.active
        : g.ended
    ).push(d);
  return g;
}
/**
 * The person's current confirmed device, sent as expectedCurrentDeviceId when confirming
 * (design §2): the server answers CONFIRM_STALE when this view is old.
 */
export function currentDevice(
  devices: readonly FieldDeviceDto[],
  personId: string,
): string | null {
  return (
    devices.find(
      (d) => d.personId === personId && d.effectiveState === 'CONFIRMED',
    )?.id ?? null
  );
}

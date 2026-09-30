import type { FieldMeDto } from '@mje/contracts';

/**
 * The device secret and what this browser last learned about it (design §2). The token is
 * generated here, stored before bind is sent (a lost bind response is resent with the same
 * token, which the server answers with the same row) and never leaves this storage except as
 * the bearer of a field request. One device per project.
 */
export interface DeviceRecord {
  projectId: string;
  projectName: string;
  personId: string;
  displayName: string;
  token: string;
  /** Known once bind has answered. */
  deviceId: string | null;
  /** The last `me` seen, to explain an ended device (expiry vs revocation). */
  last: {
    state: FieldMeDto['device']['state'];
    pendingUntil: string | null;
    expiresAt: string;
    memberUntil: string | null;
    /** When this browser last authenticated successfully (idle expiry is 30 days). */
    okAt: string;
  } | null;
}
const KEY = 'mje-field-devices';
const TOKEN = /^fd1\.[A-Za-z0-9_-]{43}$/;

/** `fd1.` + base64url of 32 random bytes (the contract's FIELD_TOKEN). */
export function newToken(
  random: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a),
): string {
  const bytes = random(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `fd1.${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function valid(r: unknown): r is DeviceRecord {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return (
    typeof x['projectId'] === 'string' &&
    typeof x['personId'] === 'string' &&
    typeof x['displayName'] === 'string' &&
    typeof x['projectName'] === 'string' &&
    typeof x['token'] === 'string' &&
    TOKEN.test(x['token']) &&
    (x['deviceId'] === null || typeof x['deviceId'] === 'string')
  );
}

/** Storage can be missing or throw (private mode); the page then works for this visit only. */
export class DeviceStore {
  private memory: DeviceRecord[] = [];
  /**
   * Set once a write fails (for example a full quota): from then on this visit keeps its own
   * copy, so a token just generated is never lost by rereading older storage (a bind retry
   * must resend the same token).
   */
  private writeFailed = false;
  constructor(private readonly storage: Storage | null) {
    this.memory = this.read();
  }
  private read(): DeviceRecord[] {
    if (!this.storage || this.writeFailed) return this.memory;
    try {
      const raw = this.storage.getItem(KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(valid) : [];
    } catch {
      return this.memory;
    }
  }
  private write(list: DeviceRecord[]) {
    this.memory = list;
    try {
      this.storage?.setItem(KEY, JSON.stringify(list));
    } catch {
      this.writeFailed = true;
    }
  }
  /** Most recently written first. */
  all(): DeviceRecord[] {
    this.memory = this.read();
    return [...this.memory];
  }
  get(projectId: string): DeviceRecord | null {
    return this.all().find((r) => r.projectId === projectId) ?? null;
  }
  put(r: DeviceRecord) {
    this.write([r, ...this.all().filter((x) => x.projectId !== r.projectId)]);
  }
  /** Only the record holding this token: a newer registration is never removed by an old tab. */
  remove(projectId: string, token: string) {
    this.write(
      this.all().filter(
        (x) => !(x.projectId === projectId && x.token === token),
      ),
    );
  }
  /** Remember a successful `me` (state and deadlines only). */
  seen(
    projectId: string,
    token: string,
    me: FieldMeDto,
    now: Date,
  ): DeviceRecord['last'] {
    const last: DeviceRecord['last'] = {
      state: me.device.state,
      pendingUntil: me.device.pendingUntil,
      expiresAt: me.device.expiresAt,
      memberUntil: me.device.memberUntil,
      okAt: now.toISOString(),
    };
    const r = this.get(projectId);
    if (r?.token === token)
      this.put({
        ...r,
        deviceId: me.device.deviceId,
        displayName: me.person.displayName,
        projectName: me.project.name,
        last,
      });
    return last;
  }
}

export type EndedReason =
  'pendingExpired' | 'expired' | 'idle' | 'unassigned' | 'revoked';
const DAY = 86_400_000;
/**
 * Why a device the server no longer accepts has ended, as far as this browser can tell from
 * its own last reading. The server says only DEVICE_ENDED / FIELD_AUTH_REQUIRED; anything not
 * explained by a deadline is shown as revoked or replaced.
 */
export function endedReason(
  last: DeviceRecord['last'],
  now: Date,
): EndedReason {
  if (!last) return 'revoked';
  const t = now.getTime();
  const past = (iso: string | null) => iso !== null && Date.parse(iso) <= t;
  if (last.state === 'PENDING' && past(last.pendingUntil))
    return 'pendingExpired';
  if (past(last.memberUntil)) return 'unassigned';
  if (past(last.expiresAt)) return 'expired';
  if (Date.parse(last.okAt) + 30 * DAY <= t) return 'idle';
  return 'revoked';
}

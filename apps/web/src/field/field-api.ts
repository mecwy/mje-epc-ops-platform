import type {
  ChallengeDto,
  CheckInCommand,
  CheckInResultDto,
  EntryDto,
  FieldMeDto,
  SelfieUploadDto,
} from '@mje/contracts';
import { ApiError, responseCode } from '../api.js';

/** ALREADY_CHECKED_IN is the only refusal that carries anything: the existing check-in. */
export interface Existing {
  occurredAt: string | null;
  kind: string;
}
export class FieldApiError extends ApiError {
  constructor(
    code: string,
    status: number,
    public readonly existing: Existing | null = null,
  ) {
    super(code, status);
  }
}
function existingOf(body: string): Existing | null {
  try {
    const e = (JSON.parse(body) as { existing?: unknown }).existing;
    if (!e || typeof e !== 'object') return null;
    const { occurredAt, kind } = e as Record<string, unknown>;
    return typeof kind === 'string' &&
      (occurredAt === null || typeof occurredAt === 'string')
      ? { occurredAt, kind }
      : null;
  } catch {
    return null;
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One field request. The device token is the bearer (never in a URL or a log); a write
 * carries Idempotency-Key, so a request lost to the network is resent with the same key and
 * body and the server answers with the original outcome. `body` is rebuilt per attempt so
 * transport fields (the device clock) are fresh while the hashed event stays the same.
 */
export async function fieldRequest<T>(
  path: string,
  o: {
    token?: string | null;
    body?: () => unknown;
    key?: string;
    form?: () => FormData;
  } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      const headers: Record<string, string> = {};
      if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
      if (o.key) headers['Idempotency-Key'] = o.key;
      if (o.body) headers['Content-Type'] = 'application/json';
      const body = o.form
        ? o.form()
        : o.body
          ? JSON.stringify(o.body())
          : undefined;
      response = await fetch(`/api/field/${path}`, {
        method: o.body || o.form ? 'POST' : 'GET',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers,
        ...(body !== undefined ? { body } : {}),
      });
    } catch {
      if (attempt >= 2) throw new FieldApiError('NETWORK', 0);
      await wait(800 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new FieldApiError(
        responseCode(response.status, text),
        response.status,
        existingOf(text),
      );
    }
    return (await response.json()) as T;
  }
}

export interface BindResult {
  deviceId: string;
  state: 'PENDING' | 'CONFIRMED';
  generation: number;
  pendingUntil: string;
}

/** Device routes. Entry and bind use the entry code; everything else the device token. */
export function deviceApi(token: () => string | null) {
  const tok = () => token();
  return {
    entry: (code: string) =>
      fieldRequest<EntryDto>('entry', { body: () => ({ code }) }),
    bind: (code: string, personId: string, newToken: string) =>
      fieldRequest<BindResult>('bind', {
        body: () => ({ code, personId, token: newToken }),
      }),
    me: () => fieldRequest<FieldMeDto>('me', { token: tok() }),
    challenge: () =>
      fieldRequest<ChallengeDto>('device/challenge', {
        token: tok(),
        body: () => ({}),
      }),
    release: (clientMutationId: string) =>
      fieldRequest<unknown>('device/release', {
        token: tok(),
        key: clientMutationId,
        body: () => ({ clientMutationId }),
      }),
    /** `build` runs per attempt (fresh deviceSentAt); the key and event never change. */
    checkIn: (key: string, build: () => CheckInCommand) =>
      fieldRequest<CheckInResultDto>('checkin', {
        token: tok(),
        key,
        body: build,
      }),
    uploadSelfie: (key: string, image: Blob) =>
      fieldRequest<SelfieUploadDto>('selfie', {
        token: tok(),
        key,
        form: () => {
          const f = new FormData();
          f.append('clientMutationId', key);
          // A generic file name: the device's own name is not needed and not sent.
          f.append('selfie', image, 'selfie');
          return f;
        },
      }),
  };
}
export type DeviceApi = ReturnType<typeof deviceApi>;

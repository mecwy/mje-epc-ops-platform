import type {
  EntryCodeDto,
  FieldDeviceDto,
  FieldSettingsCommand,
  FieldSettingsDto,
  SiteReferenceCommand,
} from '@mje/contracts';
import type { ReportApi } from '../api.js';
import { FieldSession, type Outcome } from '../field/session.js';
import { currentDevice } from './site-form.js';

type SiteApi = Pick<
  ReportApi,
  | 'entryCode'
  | 'rotateEntryCode'
  | 'devices'
  | 'confirmDevice'
  | 'rejectDevice'
  | 'revokeDevice'
  | 'fieldSettings'
  | 'setFieldSettings'
  | 'setSiteReference'
>;

export type DeviceAction =
  | { kind: 'confirm'; device: FieldDeviceDto; code: string }
  | { kind: 'reject'; device: FieldDeviceDto }
  | { kind: 'revoke'; device: FieldDeviceDto };

/**
 * PM device commands with the identity of the unresolved one: while an action's outcome is
 * unknown, no other device's action starts, and its retry is offered as that action (device
 * and kind), never as another row's. Built the IssueSession way on the device list read.
 */
export class DeviceCommands {
  readonly session: FieldSession<FieldDeviceDto[]>;
  /** The action whose command is kept for an unchanged retry. */
  unresolved: DeviceAction | null = null;

  constructor(
    private readonly api: SiteApi,
    private readonly projectId: string,
    notify: () => void,
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {
    this.session = new FieldSession(() => api.devices(projectId), notify);
  }
  /** A new action may start only when nothing is unresolved. */
  get canStart() {
    return this.unresolved === null && !this.session.busy;
  }

  async run(a: DeviceAction): Promise<Outcome<unknown>> {
    if (!this.canStart)
      return { kind: 'failed', code: this.session.error ?? 'NETWORK' };
    const key = this.newKey();
    const r = await this.session.act((list) => {
      if (a.kind === 'confirm')
        return {
          key,
          send: () =>
            this.api.confirmDevice({
              projectId: this.projectId,
              clientMutationId: key,
              personId: a.device.personId,
              code: a.code,
              // From the newest list when it runs; an older view gets CONFIRM_STALE.
              expectedCurrentDeviceId: currentDevice(
                list ?? [],
                a.device.personId,
              ),
            }),
        };
      const row = list?.find((x) => x.id === a.device.id);
      if (!row) return null;
      const c = {
        projectId: this.projectId,
        clientMutationId: key,
        deviceId: row.id,
        expectedVersion: row.version,
      };
      return {
        key,
        send: () =>
          a.kind === 'reject'
            ? this.api.rejectDevice(c)
            : this.api.revokeDevice(c),
      };
    });
    this.unresolved = r.kind === 'failed' && this.session.pending ? a : null;
    return r;
  }
  /** Resend the unresolved action unchanged. */
  async retry(): Promise<Outcome<unknown>> {
    const r = await this.session.retry();
    if (!this.session.pending) this.unresolved = null;
    return r;
  }
  /** Give up the unresolved action (it may still have been applied; the list is reread). */
  discard() {
    this.session.discard();
    this.unresolved = null;
    void this.session.load();
  }
}

/**
 * The People page's command state, kept for the life of the workspace like the issue and plan
 * sessions: switching tabs never drops an unresolved command or its key (a wrong challenge
 * code retried under a new key would be counted twice).
 */
export class SiteSessions {
  private readonly listeners = new Set<() => void>();
  readonly entry: FieldSession<EntryCodeDto>;
  readonly devices: DeviceCommands;
  readonly site: FieldSession<FieldSettingsDto>;
  readonly settings: FieldSession<FieldSettingsDto>;

  constructor(api: SiteApi, projectId: string) {
    const notify = () => this.listeners.forEach((fn) => fn());
    this.entry = new FieldSession(() => api.entryCode(projectId), notify);
    this.devices = new DeviceCommands(api, projectId, notify);
    this.site = new FieldSession(() => api.fieldSettings(projectId), notify);
    this.settings = new FieldSession(
      () => api.fieldSettings(projectId),
      notify,
    );
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * The site-location command against the version the form was edited from (never a newer one
 * read later): a stale form gets VERSION_CONFLICT and shows the newer reference instead of
 * overwriting it.
 */
export function siteReferenceCommand(
  projectId: string,
  editedFrom: FieldSettingsDto,
  value: { lat: string; lon: string; radiusM: number },
  key: string,
): SiteReferenceCommand {
  return {
    projectId,
    clientMutationId: key,
    expectedN: editedFrom.siteReference?.n ?? 0,
    ...value,
  };
}
/** The field-settings command against the version the form was edited from. */
export function settingsCommand(
  projectId: string,
  editedFrom: FieldSettingsDto,
  value: { selfieEnabled: boolean; pmProxyDays: number },
  key: string,
): FieldSettingsCommand {
  return {
    projectId,
    clientMutationId: key,
    expectedN: editedFrom.settings.n,
    ...value,
  };
}

export type QrState =
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | { kind: 'none' }
  /** The shown code may already be retired (a rotation succeeded but no reread landed). */
  | { kind: 'stale' }
  | { kind: 'code'; code: string; createdAt: string | null };
/** What the QR card may show; only a code known to be current is shown and printable. */
export function qrState(s: FieldSession<EntryCodeDto>): QrState {
  if (s.error === 'STALE') return { kind: 'stale' };
  if (!s.data)
    return s.readError
      ? { kind: 'error', code: s.readError }
      : { kind: 'loading' };
  return s.data.code
    ? { kind: 'code', code: s.data.code, createdAt: s.data.createdAt }
    : { kind: 'none' };
}

/**
 * Save the site location from a form edited on `editedFrom` (the component's snapshot). The
 * command is built when it runs but keeps the edited-from number, so a form that went stale
 * while a reread failed is refused (VERSION_CONFLICT) instead of overwriting the newer value.
 */
export function saveSiteReference(
  session: FieldSession<FieldSettingsDto>,
  api: Pick<SiteApi, 'setSiteReference'>,
  projectId: string,
  editedFrom: FieldSettingsDto,
  value: { lat: string; lon: string; radiusM: number },
  newKey: () => string = () => crypto.randomUUID(),
): Promise<Outcome<unknown>> {
  if (session.pending) return session.retry();
  return session.act(() => {
    const c = siteReferenceCommand(projectId, editedFrom, value, newKey());
    return { key: c.clientMutationId, send: () => api.setSiteReference(c) };
  });
}
/** Save field settings from a form edited on `editedFrom`; see saveSiteReference. */
export function saveSettings(
  session: FieldSession<FieldSettingsDto>,
  api: Pick<SiteApi, 'setFieldSettings'>,
  projectId: string,
  editedFrom: FieldSettingsDto,
  value: { selfieEnabled: boolean; pmProxyDays: number },
  newKey: () => string = () => crypto.randomUUID(),
): Promise<Outcome<unknown>> {
  if (session.pending) return session.retry();
  return session.act(() => {
    const c = settingsCommand(projectId, editedFrom, value, newKey());
    return { key: c.clientMutationId, send: () => api.setFieldSettings(c) };
  });
}

import type {
  CheckInListDto,
  EntryCodeDto,
  PmProxyCheckInCommand,
  RosterDto,
  FieldDeviceDto,
  FieldSettingsCommand,
  FieldSettingsDto,
  SiteReferenceCommand,
} from '@mje/contracts';
import type { ReportApi } from '../api.js';
import { OwnedCommands } from '../field/owned-commands.js';
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
  | 'roster'
  | 'checkIns'
  | 'pmProxy'
>;

export type DeviceAction =
  | { kind: 'confirm'; device: FieldDeviceDto; code: string }
  | { kind: 'reject'; device: FieldDeviceDto }
  | { kind: 'revoke'; device: FieldDeviceDto };

/**
 * PM device commands (confirm by code, reject, revoke). Built on OwnedCommands: the action
 * that starts a command owns it from the first moment, so an unresolved Retry is always that
 * device's own action and key, even when another sheet was opened during a recovery read.
 */
export class DeviceCommands {
  readonly session: FieldSession<FieldDeviceDto[]>;
  private readonly owned: OwnedCommands<FieldDeviceDto[], DeviceAction>;

  constructor(
    private readonly api: SiteApi,
    private readonly projectId: string,
    notify: () => void,
    newKey: () => string = () => crypto.randomUUID(),
  ) {
    this.session = new FieldSession(() => api.devices(projectId), notify);
    this.owned = new OwnedCommands(this.session, newKey);
  }
  /** The action whose own command is kept for an unchanged retry. */
  get unresolved(): DeviceAction | null {
    return this.owned.unresolved;
  }
  /** The action running or unresolved: what its sheet shows (read-only). */
  get current(): DeviceAction | null {
    return this.owned.current;
  }
  /** Moves whenever an action's ownership ends (an edit sheet restarts from empty). */
  get generation(): number {
    return this.owned.generation;
  }
  /** A new action may start only when no action is running or unresolved. */
  get canStart() {
    return this.owned.canStart;
  }

  run(a: DeviceAction): Promise<Outcome<unknown>> {
    return this.owned.run(a, (list, key) => {
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
  }
  /** Resend the unresolved action unchanged. */
  retry(): Promise<Outcome<unknown>> {
    return this.owned.retry();
  }
  /** Give up the unresolved action (it may still have been applied; the list is reread). */
  discard() {
    this.owned.discard();
  }
}

/** A settings form's save as sent: the version it was edited from and the values. */
export interface FormSave<V> {
  editedFrom: FieldSettingsDto;
  value: V;
}
export type SiteValue = { lat: string; lon: string; radiusM: number };
export type SettingsValue = { selfieEnabled: boolean; pmProxyDays: number };

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
  /** Saves with their payloads: a form shown again shows what its Retry would send. */
  readonly siteSave: OwnedCommands<FieldSettingsDto, FormSave<SiteValue>>;
  readonly settingsSave: OwnedCommands<
    FieldSettingsDto,
    FormSave<SettingsValue>
  >;

  private readonly notify = () => this.listeners.forEach((fn) => fn());
  constructor(
    private readonly api: SiteApi,
    private readonly projectId: string,
  ) {
    const notify = this.notify;
    this.roster = new FieldSession(() => api.roster(projectId), notify);
    this.entry = new FieldSession(() => api.entryCode(projectId), notify);
    this.devices = new DeviceCommands(api, projectId, notify);
    this.site = new FieldSession(() => api.fieldSettings(projectId), notify);
    this.settings = new FieldSession(
      () => api.fieldSettings(projectId),
      notify,
    );
    this.siteSave = new OwnedCommands(this.site);
    this.settingsSave = new OwnedCommands(this.settings);
  }
  readonly roster: FieldSession<RosterDto>;
  private readonly days = new Map<
    string,
    {
      list: FieldSession<CheckInListDto>;
      proxy: OwnedCommands<CheckInListDto, ProxyAction>;
    }
  >();
  /** A site day's check-ins and PM proxies, kept for the workspace's life. */
  checkIns(businessDate: string) {
    let d = this.days.get(businessDate);
    if (!d) {
      const list = new FieldSession<CheckInListDto>(
        () => this.api.checkIns(this.projectId, businessDate),
        this.notify,
      );
      d = { list, proxy: new OwnedCommands(list) };
      this.days.set(businessDate, d);
    }
    return d;
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
 * command keeps the edited-from number, so a form that went stale while a reread failed is
 * refused (VERSION_CONFLICT) instead of overwriting the newer value. The payload is owned by
 * the save, so a form shown again (another tab and back) shows what its Retry sends.
 */
export function saveSiteReference(
  commands: OwnedCommands<FieldSettingsDto, FormSave<SiteValue>>,
  api: Pick<SiteApi, 'setSiteReference'>,
  projectId: string,
  editedFrom: FieldSettingsDto,
  value: SiteValue,
): Promise<Outcome<unknown>> {
  return commands.run({ editedFrom, value }, (_d, key) => {
    const c = siteReferenceCommand(projectId, editedFrom, value, key);
    return { key, send: () => api.setSiteReference(c) };
  });
}
/** Save field settings from a form edited on `editedFrom`; see saveSiteReference. */
export function saveSettings(
  commands: OwnedCommands<FieldSettingsDto, FormSave<SettingsValue>>,
  api: Pick<SiteApi, 'setFieldSettings'>,
  projectId: string,
  editedFrom: FieldSettingsDto,
  value: SettingsValue,
): Promise<Outcome<unknown>> {
  return commands.run({ editedFrom, value }, (_d, key) => {
    const c = settingsCommand(projectId, editedFrom, value, key);
    return { key, send: () => api.setFieldSettings(c) };
  });
}

/** A PM proxy check-in as sent (its command, shown locked while unresolved). */
export type ProxyAction = Omit<PmProxyCheckInCommand, 'clientMutationId'>;

import type { FieldMeDto } from '@mje/contracts';
import type { LocateResult } from '../report/geo.js';
import { CrewCommands } from './crew-commands.js';
import type { DeviceApi } from './field-api.js';
import { ReportDays } from './foreman-report.js';
import { ProxyFlow } from './proxy-flow.js';
import type { FieldSession } from './session.js';

/**
 * The owners of a foreman's commands (AGENTS.md: an owner lives for the device session, never
 * for a role or a tab): crew confirm/reject, crew check-in and the quantity reports. The
 * device page makes them once and keeps them while the foreman role comes and goes, so an
 * unresolved attempt keeps its key, payload, Retry and Give up.
 */
export interface ForemanOwners {
  crew: CrewCommands;
  proxy: ProxyFlow;
  reports: ReportDays;
}

export function foremanOwners(o: {
  api: DeviceApi;
  /** The device page's own `me` session (crew decisions run on it). */
  session: FieldSession<FieldMeDto>;
  me: FieldMeDto;
  storage: Storage | null;
  locate: () => Promise<LocateResult>;
  notify: () => void;
  onEnded: (code: string) => void;
}): ForemanOwners {
  return {
    crew: new CrewCommands(o.session, o.api),
    proxy: new ProxyFlow({
      api: o.api,
      deviceId: o.me.device.deviceId,
      timeZone: o.me.project.timezone,
      storage: o.storage,
      locate: o.locate,
      now: () => Date.now(),
      newKey: () => crypto.randomUUID(),
      onEnded: o.onEnded,
      notify: o.notify,
    }),
    reports: new ReportDays(o.api, o.notify, o.onEnded),
  };
}

/*
 * Test fixture (not part of the app bundle): one project's report day on a fake report
 * server, driven through the real DayStore (useDay's logic), the real DraftSession, the real
 * PmOwners / AdoptFlow and the real workspace binding (pmDayBinding), wired exactly as the
 * workspace wires them (App.tsx: `pm.day ??= pmDayBinding(h.store, project.id)`).
 */
import type {
  DayFactsDto,
  ForemanAdoptCommand,
  SaveFactsCommand,
} from '@mje/contracts';
import { ApiError, type DayView, type ForemanDayView } from '../api.js';
import { DayStore } from '../report/day-store.js';
import { PmOwners, pmDayBinding } from './pm-owners.js';

export const P = '11111111-1111-4111-8111-111111111111';
export const Q = '22222222-2222-4222-8222-222222222222';
export const DAY = '2026-10-02';

export const view = (
  value: string | null,
  status: 'COMPLETE' | 'PARTIAL' = 'COMPLETE',
  crews = true,
): ForemanDayView => ({
  rosterVersion: 1,
  expectedCrews: crews
    ? [{ crewId: 'c', code: 'A', name: 'TEST A', hasForeman: true }]
    : [],
  revisions: [],
  items: crews
    ? {
        support: {
          status,
          value,
          atLeast: null,
          crews: { c: { status: 'VALUE', qty: value, expected: true } },
        },
      }
    : {},
  adoptions: [],
  basis: {
    rosterVersion: 1,
    expectedCrews: crews ? ['c'] : [],
    revisions: [{ crewId: 'c', n: 1 }],
  },
  expectedCrewsChanged: null,
});

export const blank = (): DayFactsDto => ({
  weather: '',
  temperature: '',
  qty: {},
  cumulative: {},
  narrative: { construction: '', quality: '', safety: '' },
  people: {},
  presence: {},
  machinery: {},
  materials: {},
  milestones: {},
  noWork: null,
  updated: {},
});

export type Gate = { hold: boolean; waiting: (() => void)[] };
const gate = (): Gate => ({ hold: false, waiting: [] });
const pass = async (g: Gate) => {
  if (g.hold) await new Promise<void>((r) => g.waiting.push(r));
};
export const open = (g: Gate) => {
  g.hold = false;
  g.waiting.splice(0).forEach((r) => r());
};

/**
 * A fake report server, one day per project: saves, adoptions and day commands check the day
 * version and bump it; an adoption sets the item's quantity to 10. Any of them, and reads, can
 * be held (delayed) or failed.
 */
export function dayServer() {
  const days = new Map<string, { version: number; facts: DayFactsDto }>();
  const at = (p: string) => {
    let d = days.get(p);
    if (!d) {
      d = { version: 1, facts: blank() };
      days.set(p, d);
    }
    return d;
  };
  const save = gate();
  const adopt = gate();
  const read = gate();
  const adoptPlan: (ApiError | 'lost')[] = [];
  const readPlan: ApiError[] = [];
  const adoptLog: ForemanAdoptCommand[] = [];
  const commands: string[] = [];
  let reads = 0;
  const command =
    (name: string) =>
    async (c: { projectId: string; expectedVersion: number }) => {
      commands.push(name);
      const d = at(c.projectId);
      if (c.expectedVersion !== d.version)
        throw new ApiError('VERSION_CONFLICT', 409);
      d.version++;
      return { version: d.version } as never;
    };
  const api = {
    day: async (projectId: string, businessDate: string): Promise<DayView> => {
      reads++;
      await pass(read);
      const fail = readPlan.shift();
      if (fail) throw fail;
      const d = at(projectId);
      return {
        projectId,
        businessDate,
        version: d.version,
        facts: d.facts,
        foreman: view('10'),
        state: 'draft',
        currentRevisionNumber: 0,
        photos: [],
      } as unknown as DayView;
    },
    revision: async () => ({}) as never,
    saveFacts: async (c: SaveFactsCommand) => {
      await pass(save);
      const d = at(c.projectId);
      if (c.expectedVersion !== d.version)
        throw new ApiError('VERSION_CONFLICT', 409);
      d.facts = c.facts;
      d.version++;
      return { businessDate: DAY, version: d.version, state: 'draft' } as never;
    },
    adoptForeman: async (c: ForemanAdoptCommand) => {
      adoptLog.push(c);
      await pass(adopt);
      const a = adoptPlan.shift();
      if (a instanceof ApiError) throw a;
      const d = at(c.projectId);
      if (c.expectedVersion !== d.version) {
        if (a === 'lost') throw new ApiError('NETWORK', 0);
        throw new ApiError('VERSION_CONFLICT', 409);
      }
      d.facts = { ...d.facts, qty: { ...d.facts.qty, [c.item]: '10' } };
      d.version++;
      if (a === 'lost') throw new ApiError('NETWORK', 0);
      return {};
    },
    noWork: command('noWork'),
    submit: command('submit'),
  };
  return {
    api,
    save,
    adopt,
    read,
    adoptPlan,
    readPlan,
    adoptLog,
    commands,
    reads: () => reads,
    facts: (p = P) => at(p).facts,
    version: (p = P) => at(p).version,
  };
}

/**
 * One workspace: its DayStore (useDay's), and per project the PM owners with the binding the
 * workspace makes. `type` is the fill page's input (DayStore.edit, refused while locked);
 * `autosave` its autosave (DayStore.flush); `load` the day's first read.
 */
export function workspace(sv: ReturnType<typeof dayServer>) {
  let conflicts = 0;
  const store = new DayStore(sv.api as never, () => {});
  store.hooks = { conflict: () => conflicts++, recovery: undefined };
  const owners = new Map<string, PmOwners>();
  /** What the workspace does on a render for project `p` (App.tsx). */
  const render = (p: string) => {
    let o = owners.get(p);
    if (!o) {
      o = new PmOwners(sv.api as never, p);
      owners.set(p, o);
    }
    o.day ??= pmDayBinding(store, p);
    return o;
  };
  const entry = (p = P) => store.entry(p, DAY);
  return {
    store,
    render,
    entry,
    conflicts: () => conflicts,
    flow: (p = P) => render(p).adoptFor(DAY),
    load: (p = P) => store.read(entry(p), false),
    type: (workers: string, p = P) =>
      store.edit(entry(p), 'people.workers', workers),
    autosave: (p = P) => store.flush(entry(p)),
    noWork: (p = P) =>
      store.act(entry(p), (v) =>
        sv.api.noWork({ projectId: p, expectedVersion: v }),
      ),
    submit: (p = P) =>
      store.act(entry(p), (v) =>
        sv.api.submit({ projectId: p, expectedVersion: v }),
      ),
  };
}

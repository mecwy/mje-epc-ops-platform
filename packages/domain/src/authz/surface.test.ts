/** Consistency of the rule model itself (ADR-0003 D4, D6). */
import { describe, expect, it } from 'vitest';
import { REPORT_PROJECTORS } from '../report-reader.js';
import { DEFERRED } from './deferred.js';
import { FIELDS } from './fields.js';
import { SURFACE, type Capability } from './surface.js';

const D1: Capability[] = [
  'report.view',
  'report.view-submitted',
  'report.write',
  'issue.view',
  'issue.write',
  'issue.reply',
  'photo.view',
  'photo.view-frozen',
  'photo.write',
  'field.admin.view',
  'field.admin.write',
  'field.device.session',
  'field.device.checkin',
  'field.device.selfie',
  'field.device.foreman',
];

describe('surface.ts', () => {
  it('has one entry per route or process, direction n/a everywhere', () => {
    const entries = SURFACE.map((e) => e.entry);
    expect(new Set(entries).size).toBe(entries.length);
    expect(SURFACE.filter((e) => e.direction !== 'n/a')).toEqual([]);
    expect(DEFERRED.map((d) => d.dimension)).toEqual([
      'direction (revenue / cost / all)',
      'contract share',
    ]);
  });
  it('uses D1 capabilities only, unless marked outside D1', () => {
    expect(
      SURFACE.filter(
        (e) => !e.outsideD1 && e.capability.some((c) => !D1.includes(c)),
      ).map((e) => e.entry),
    ).toEqual([]);
  });
  it('gives every read a projector per capability and every write a command and mode', () => {
    for (const e of SURFACE) {
      for (const c of e.capability) {
        expect(e.layers[c], `${e.entry} layers ${c}`).toBeDefined();
        expect(e.temporal[c], `${e.entry} temporal ${c}`).toBeDefined();
        if (e.kind === 'read')
          expect(e.projector?.[c], `${e.entry} projector ${c}`).toBeDefined();
      }
      if (e.kind === 'write') {
        expect(e.command, e.entry).toBeDefined();
        expect(e.concurrency, e.entry).not.toBe('read');
      } else expect(e.concurrency, e.entry).toBe('read');
    }
  });
  it('layers every report, issue and photo read through a field table', () => {
    const layered = SURFACE.filter(
      (e) =>
        e.kind === 'read' &&
        e.capability.some((c) => /^(report|issue)\./.test(c)),
    );
    for (const e of layered)
      for (const c of e.capability)
        expect(FIELDS, `${e.entry} ${c}`).toHaveProperty([e.projector![c]!]);
    const photoMeta = SURFACE.filter(
      (e) => e.entry === 'GET /api/report/photos' || e.entry.endsWith('/meta'),
    );
    for (const e of photoMeta)
      for (const c of e.capability)
        expect(FIELDS).toHaveProperty([e.projector![c]!]);
  });
  it('names the report exit projectors for the report reads, and no other', () => {
    const named = SURFACE.filter((e) => e.capability.includes('report.view'))
      .flatMap((e) => Object.values(e.projector ?? {}))
      .concat(['report.lagHistory']);
    expect([...new Set(named)].sort()).toEqual([...REPORT_PROJECTORS].sort());
  });
  it('every cas base is advanced by some writer (D4/D7)', () => {
    const advanced = new Set(SURFACE.flatMap((e) => e.advances));
    for (const e of SURFACE.filter((x) => x.concurrency === 'cas')) {
      expect(e.protects?.length, e.entry).toBeGreaterThan(0);
      for (const v of e.protects ?? [])
        expect(advanced.has(v), `${e.entry} protects ${v}`).toBe(true);
    }
  });
  it('registers the existence disclosures it knows of (D3)', () => {
    expect(
      SURFACE.filter((e) => e.discloses !== 'none').map((e) => [
        e.entry,
        typeof e.discloses === 'object' ? e.discloses.code : '',
      ]),
    ).toEqual([
      ['POST /api/report/photos', 'PHOTO_ELSEWHERE'],
      ['POST /api/field/entry', 'entry roster'],
    ]);
  });
});

/** Consistency of the rule model itself (ADR-0003 D4, D6). */
import { describe, expect, it } from 'vitest';
import { REPORT_PROJECTORS } from '../report-reader.js';
import { DEFERRED } from './deferred.js';
import { FIELDS } from './fields.js';
import { SURFACE, type Capability } from './surface.js';

const D1: Capability[] = [
  'contract.view',
  'contract.maintain',
  'contract.attention',
  'project.status.view',
  'project.status.declare',
  'project.status.reply',
  'project.master.write',
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
  it('C05 has its own strongly typed read projection and versioned write registration', () => {
    const read = SURFACE.find(
      (e) => e.entry === 'GET /api/report/business-evidence',
    )!;
    const write = SURFACE.find(
      (e) => e.entry === 'POST /api/report/business-evidence',
    )!;
    expect(read.projector).toEqual({
      'report.view': 'report.businessEvidence',
      'report.view-submitted': 'report.businessEvidence',
    });
    expect(read.temporal).toEqual({
      'report.view': 'live',
      'report.view-submitted': 'frozen',
    });
    expect(FIELDS['report.businessEvidence'].fields.declaration).toEqual({
      layer: 'field-writer',
      fields: {
        qty: { layer: 'field-writer' },
        unit: { layer: 'structure' },
        scopeRef: { layer: 'structure' },
      },
    });
    expect(write.command).toBe('BusinessEvidenceStore.write');
    expect(write.concurrency).toBe('cas');
    expect(write.protects).toContain('BusinessEvidenceVersion.version');
  });

  it('has one entry per route or process, direction explicit on contract entries', () => {
    const entries = SURFACE.map((e) => e.entry);
    expect(new Set(entries).size).toBe(entries.length);
    expect(
      SURFACE.filter((e) => e.direction !== 'n/a').map((e) => e.entry),
    ).toEqual([
      'GET /api/contracts/lookups',
      'GET /api/contracts/:id/editor',
      'POST /api/contracts',
      'POST /api/contracts/:id/corrections',
      'POST /api/contracts/:id/shares',
      'POST /api/contracts/:id/attention/read',
      'GET /api/contracts',
      'GET /api/contracts/:id',
      'GET /api/contracts/:id/history',
    ]);
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
        e.capability.some((c) =>
          /^(report|issue|contract|opportunity|project\.(status|master))\./.test(
            c,
          ),
        ),
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
      .concat(['report.lagHistory', 'report.home']);
    expect([...new Set(named)].sort()).toEqual(
      [...REPORT_PROJECTORS, 'report.businessEvidence'].sort(),
    );
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
  it('declares what each field writer advances (audit against the code, PR #51 review 7)', () => {
    const advances = (entry: string) =>
      [...(SURFACE.find((e) => e.entry === entry)?.advances ?? [])].sort();
    const V = 'FieldDevice.version';
    const CUR = 'FieldDevice.current(person)';
    // endDevice (field-kit) bumps FieldDevice.version.
    expect(advances('POST /api/field/devices/reject')).toEqual([CUR, V].sort());
    expect(advances('POST /api/report/field/devices/reject')).toEqual([V]);
    // Release and revoke end the person's current device.
    expect(advances('POST /api/field/device/release')).toEqual([CUR, V].sort());
    expect(advances('POST /api/report/field/devices/revoke')).toEqual(
      [CUR, V].sort(),
    );
    // recomputeDevices on a roster change.
    expect(advances('POST /api/report/field/roster/changes')).toEqual(
      ['ProjectRoster.version', V, CUR].sort(),
    );
    expect(advances('POST /api/report/field/crews')).toEqual([
      'ProjectRoster.version',
    ]);
    // Adoption takes a field day sequence number (nextSeq).
    expect(advances('POST /api/report/foreman/adopt')).toEqual(
      ['DailyClose.version', 'FieldDay.seq'].sort(),
    );
    // A new pending device advances nothing another command depends on.
    expect(advances('POST /api/field/bind')).toEqual([]);
    // Any device request may end its expired device (fieldTransaction).
    expect(advances('GET /api/field/me')).toEqual([CUR, V].sort());
    expect(advances('POST /api/field/checkin')).toEqual(
      [CUR, V, 'FieldDay.seq'].sort(),
    );
  });
});

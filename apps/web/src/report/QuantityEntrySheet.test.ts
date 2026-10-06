import { describe, expect, it } from 'vitest';
import { QuantityEntrySession } from './QuantityEntrySheet.js';
import { quantityEntryText } from '../i18n.js';

const source = {
  scope: JSON.stringify(['TEST-project-A', '2026-10-06', 'TEST-racks', 'set']),
  value: '10',
  locked: false,
};

describe('temporary quantity entry', () => {
  it('cancel preserves the source and cannot apply the temporary 20 later', () => {
    const entry = new QuantityEntrySession();
    entry.open(source);
    entry.edit('20');
    expect(source.value).toBe('10');
    entry.cancel();
    expect(entry.confirm(source)).toEqual({ kind: 'dismiss' });
    entry.open(source);
    expect(entry.value).toBe('10');
  });

  it.each(['0', '', 'unknown', 'na', '20', '0.125001'])(
    'confirms %j without converting strings, tokens, or decimal precision',
    (value) => {
      const entry = new QuantityEntrySession();
      entry.open(source);
      entry.edit(value);
      expect(entry.confirm(source)).toEqual({ kind: 'apply', value });
      expect(source.value).toBe('10');
      expect(entry.confirm(source)).toEqual({ kind: 'dismiss' });
    },
  );

  it.each(['1.1234567', '1e3', '-1', 'abc'])(
    'retains invalid %j for correction without applying it',
    (value) => {
      const entry = new QuantityEntrySession();
      entry.open(source);
      entry.edit(value);
      expect(entry.confirm(source)).toEqual({ kind: 'invalid' });
      expect(entry.value).toBe(value);
      entry.edit('1.123456');
      expect(entry.confirm(source)).toEqual({
        kind: 'apply',
        value: '1.123456',
      });
    },
  );

  it('cannot open or confirm while read-only or pending', () => {
    const entry = new QuantityEntrySession();
    expect(entry.open({ ...source, locked: true })).toBe(false);
    entry.open(source);
    entry.edit('20');
    expect(entry.confirm({ ...source, locked: true })).toEqual({
      kind: 'dismiss',
    });
  });

  it.each([
    ['TEST-project-B', '2026-10-06', 'TEST-racks', 'set'],
    ['TEST-project-A', '2026-10-05', 'TEST-racks', 'set'],
    ['TEST-project-A', '2026-10-06', 'TEST-modules', 'set'],
    ['TEST-project-A', '2026-10-06', 'TEST-racks', 'm'],
  ])(
    'does not apply to another project/day/item/unit: %j/%j/%j/%j',
    (...parts) => {
      const entry = new QuantityEntrySession();
      entry.open(source);
      entry.edit('20');
      expect(
        entry.confirm({ ...source, scope: JSON.stringify(parts) }),
      ).toEqual({
        kind: 'dismiss',
      });
    },
  );

  it('does not overwrite a source quantity changed during entry', () => {
    const entry = new QuantityEntrySession();
    entry.open(source);
    entry.edit('20');
    expect(entry.confirm({ ...source, value: '15' })).toEqual({
      kind: 'dismiss',
    });
  });
});

describe('quantity entry language boundary', () => {
  it('uses brief Chinese and English labels without altering existing catalogues', () => {
    expect(quantityEntryText('zh').quantity).toBe('完成量');
    expect(quantityEntryText('en').quantity).toBe('Completed quantity');
    expect(quantityEntryText('sr')).toEqual(quantityEntryText('en'));
    expect(quantityEntryText('es')).toEqual(quantityEntryText('en'));
  });
});

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  FieldMeDto,
  ForemanReportCommand,
  ForemanReportDto,
} from '@mje/contracts';
import { ApiError } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { CrewCommands } from './crew-commands.js';
import { ConfirmSheet, ReportDayBody } from './ForemanPanel.js';
import {
  ReportDay,
  reportPayload,
  sendReport,
  type ReportSend,
} from './foreman-report.js';
import { OwnedCommands } from './owned-commands.js';
import { FieldSession } from './session.js';

const wrap = (el: ReturnType<typeof createElement>) =>
  renderToString(createElement(I18nProvider, null, el));
const report = (n: number, qty: string): ForemanReportDto => ({
  crewId: '11111111-1111-4111-8111-111111111111',
  crewName: 'TEST crew',
  businessDate: '2026-10-02',
  n,
  rows: [{ itemKey: 'support', qty }],
  note: '',
  occurredAt: null,
  receivedAt: null,
  items: [{ key: 'support', label: 'TEST support', unit: 'set' }],
});

describe('#39 quantity form follows the rule: form state = the owned send payload', () => {
  it('a send carries the revision it was edited from; a stale draft is refused, never re-bound', async () => {
    let server = report(1, '10');
    const sent: ForemanReportCommand[] = [];
    const session = new FieldSession<ForemanReportDto>(
      async () => server,
      () => {},
    );
    await session.load();
    const editedOn = session.data!;
    server = report(2, '15'); // another send lands
    await session.load(); // and is read before this draft is sent
    const sends = new OwnedCommands<ForemanReportDto, ReportSend>(session);
    const r = await sendReport(
      sends,
      {
        submitReport: async (c: ForemanReportCommand) => {
          sent.push(c);
          if (c.expectedRevision !== server.n)
            throw new ApiError('REVISION_CONFLICT', 409);
          return {};
        },
      },
      reportPayload(editedOn, [{ itemKey: 'support', qty: '12' }], ''),
    );
    expect(r).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(sent.map((c) => c.expectedRevision)).toEqual([1]);
    expect(sends.current).toBeNull();
    expect(sends.refusal).toBe('REVISION_CONFLICT');
  });
  it('while owned only the sent rows show, read-only', async () => {
    const day = new ReportDay(
      {
        report: async () => report(1, '10'),
        submitReport: () => Promise.reject(new ApiError('NETWORK', 0)),
      },
      '2026-10-02',
      () => {},
      () => {},
    );
    await day.session.load();
    await day.send(
      reportPayload(day.session.data!, [{ itemKey: 'support', qty: '12' }], ''),
    );
    const owned = wrap(
      createElement(ReportDayBody, {
        report: day,
        timeZone: 'Europe/Belgrade',
      }),
    );
    expect(owned).not.toContain('<input');
    expect(owned).toContain('>12<');
  });
});

describe('#39 crew confirm sheet follows the rule', () => {
  const me: FieldMeDto = {
    device: {
      deviceId: 'd',
      state: 'CONFIRMED',
      generation: 0,
      pendingUntil: null,
      expiresAt: '2027-01-01T00:00:00.000Z',
      memberUntil: null,
      tokenIssuedAt: '2026-10-01T00:00:00.000Z',
    },
    person: { id: 'f', displayName: 'TEST foreman' },
    project: { id: 'p', name: 'TEST', timezone: 'Europe/Belgrade' },
    settings: { selfieEnabled: false },
    crew: null,
    foreman: {
      crewId: 'c',
      crewName: 'TEST crew',
      members: [
        {
          personId: 'w',
          displayName: 'TEST worker',
          currentDeviceId: null,
          pendingDevices: 1,
        },
      ],
    },
  };
  it('no code input while an attempt is unresolved; its own code is shown and resent', async () => {
    const sentCodes: string[] = [];
    const session = new FieldSession<FieldMeDto>(
      async () => me,
      () => {},
    );
    await session.load();
    const commands = new CrewCommands(session, {
      confirmCrew: async (c) => {
        sentCodes.push(c.code);
        throw new ApiError('NETWORK', 0);
      },
      rejectCrew: async () => ({}) as never,
    });
    await commands.run({
      personId: 'w',
      name: 'TEST',
      what: 'confirm',
      code: '111111',
    });
    const html = wrap(
      createElement(ConfirmSheet, {
        commands,
        member: me.foreman!.members[0]!,
        onClose: () => {},
      }),
    );
    expect(html).not.toContain('<input');
    expect(html).toContain('>111111<');
    await commands.retry();
    expect(sentCodes).toEqual(['111111', '111111']);
  });
});

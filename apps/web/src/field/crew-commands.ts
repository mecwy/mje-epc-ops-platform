import type { FieldMeDto } from '@mje/contracts';
import type { DeviceApi } from './field-api.js';
import { crewDecision } from './foreman-report.js';
import { OwnedCommands } from './owned-commands.js';
import type { FieldSession, Outcome } from './session.js';

/** A foreman's confirm or reject as sent: whose phone, which decision, which code. */
export interface CrewAttempt {
  personId: string;
  what: 'confirm' | 'reject';
  code: string;
}

/**
 * The foreman's confirm/reject commands (design §2, C2). A retry resends the command exactly
 * as it was sent (same person, decision, code and key), so the attempt owns its command from
 * the moment it starts (OwnedCommands): while it runs or is unresolved its code is shown and
 * cannot be edited, and no other member's decision can start. The foreman either retries it
 * or gives it up, then types again. A correct code is therefore never answered with the
 * decision of an earlier, unresolved attempt.
 */
export class CrewCommands {
  private readonly owned: OwnedCommands<FieldMeDto, CrewAttempt>;

  constructor(
    session: FieldSession<FieldMeDto>,
    private readonly api: Pick<DeviceApi, 'confirmCrew' | 'rejectCrew'>,
    newKey: () => string = () => crypto.randomUUID(),
  ) {
    this.owned = new OwnedCommands(session, newKey);
  }

  get busy() {
    return this.owned.session.busy;
  }
  /** The attempt kept for an unchanged retry (settled without an answer). */
  get unresolved(): CrewAttempt | null {
    return this.owned.unresolved;
  }
  /** The attempt running or unresolved: its code is what the sheet shows. */
  get current(): CrewAttempt | null {
    return this.owned.current;
  }
  get canStart() {
    return this.owned.canStart;
  }
  isUnresolved(personId: string) {
    return this.unresolved?.personId === personId;
  }

  run(a: CrewAttempt): Promise<Outcome<unknown>> {
    return this.owned.run(a, (me, key) => {
      const d = crewDecision(me, a.personId, a.code, key, a.what);
      if (!d) return null;
      return {
        key,
        send: () =>
          d.kind === 'confirm'
            ? this.api.confirmCrew(d.command)
            : this.api.rejectCrew(d.command),
      };
    });
  }
  retry(): Promise<Outcome<unknown>> {
    return this.owned.retry();
  }
  /** Give up the unresolved attempt (a wrong code may then have counted once); reread. */
  discard() {
    this.owned.discard();
  }
}

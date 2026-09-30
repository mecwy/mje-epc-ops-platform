import type { FieldMeDto } from '@mje/contracts';
import type { DeviceApi } from './field-api.js';
import { crewDecision } from './foreman-report.js';
import type { FieldSession, Outcome } from './session.js';

/** A foreman's confirm or reject as sent: whose phone, which decision, which code. */
export interface CrewAttempt {
  personId: string;
  what: 'confirm' | 'reject';
  code: string;
}

/**
 * The foreman's confirm/reject commands (design §2, C2) with the identity of an unresolved
 * one. A retry resends the command exactly as it was sent: same person, decision, code and
 * key. So while one is unresolved the code cannot be edited (a retry would silently send the
 * old code and its answer would be shown against the new one) and no other member's decision
 * can start; the foreman either retries it or gives it up, then types again.
 */
export class CrewCommands {
  unresolved: CrewAttempt | null = null;

  constructor(
    private readonly session: FieldSession<FieldMeDto>,
    private readonly api: Pick<DeviceApi, 'confirmCrew' | 'rejectCrew'>,
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {}

  get busy() {
    return this.session.busy;
  }
  /** A new decision may start only when nothing is unresolved. */
  get canStart() {
    return this.unresolved === null && !this.session.busy;
  }
  /** Whether this attempt's command is the unresolved one (its sheet offers the retry). */
  isUnresolved(personId: string) {
    return this.unresolved?.personId === personId;
  }

  async run(a: CrewAttempt): Promise<Outcome<unknown>> {
    if (!this.canStart)
      return { kind: 'failed', code: this.session.error ?? 'NETWORK' };
    const key = this.newKey();
    const r = await this.session.act((me) => {
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
    this.unresolved = r.kind === 'failed' && this.session.pending ? a : null;
    return r;
  }
  /** Resend the unresolved attempt unchanged. */
  async retry(): Promise<Outcome<unknown>> {
    const r = await this.session.retry();
    if (!this.session.pending) this.unresolved = null;
    return r;
  }
  /**
   * Give up the unresolved attempt. It may still have reached the server (a wrong code then
   * counts once); the crew list is read again before anything else is sent.
   */
  discard() {
    this.session.discard();
    this.unresolved = null;
    void this.session.load();
  }
}

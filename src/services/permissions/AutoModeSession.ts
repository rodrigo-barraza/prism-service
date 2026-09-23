/**
 * AutoModeSession — what auto mode remembers across one turn.
 *
 * One per turn, carried on the turn's PermissionModeHandle and shared by
 * every sub-agent the turn spawns (a definition's derived handle shares it
 * too), so the whole delegation tree has one circuit breaker, one view of
 * what the user asked for, and one classifier bill.
 *
 * The circuit breaker. The classifier is a model; when it keeps saying no,
 * the likelier story is that it lacks context, or that the agent is stuck
 * pushing at the same wall. Either way a person should look:
 *
 *   - 3 denials in a row, or 10 of the last 50 verdicts, TRIP it. The call
 *     that tripped it is not denied quietly: it becomes an approval card —
 *     the turn stops and asks the user.
 *   - While it is tripped (paused), every call that would have gone to the
 *     classifier asks instead, without a classifier call.
 *   - A person allowing one of those cards resumes auto mode: both counters
 *     start over.
 *
 * Only real verdicts count. A classifier that failed produced no verdict (it
 * asks — see AutoModeClassifier), and a reviewer's own "ask" is neither a
 * yes nor a no.
 */

export const AUTO_MODE_BREAKER = {
  /** Denials in a row that trip the breaker. */
  CONSECUTIVE_DENIALS: 3,
  /** How many recent verdicts the rate threshold looks at. */
  WINDOW: 50,
  /** Denials within the window that trip the breaker. */
  WINDOW_DENIALS: 10,
} as const;

export interface AutoModePause {
  /** Which threshold tripped. */
  trippedBy: "consecutive" | "window";
  /** Denials behind the trip (in a row, or within the window). */
  denials: number;
  /** For the card and the model: why auto mode stopped deciding. */
  reason: string;
}

export class AutoModeSession {
  private consecutive = 0;
  /** The last WINDOW verdicts, oldest first; `true` = denied. */
  private recent: boolean[] = [];
  private pause: AutoModePause | null = null;

  /**
   * The root conversation's user-authored messages, newest last. The root
   * turn's gate refreshes it on every batch; a sub-agent's classifier reads
   * it, because what a sub-agent may do is bounded by what the USER asked —
   * its own "user" message is a task another agent wrote.
   */
  userMessages: string[] = [];

  /** PRISM.md for this turn, read once (null until read). */
  instructions: Promise<string> | null = null;

  /** Classifier and reviewer calls made for this turn, and their estimated cost. */
  calls = 0;
  spentDollars = 0;

  get paused(): AutoModePause | null {
    return this.pause;
  }

  get consecutiveDenials(): number {
    return this.consecutive;
  }

  get recentDenials(): number {
    return this.recent.filter(Boolean).length;
  }

  /**
   * Record one verdict. Returns the pause when this verdict tripped the
   * breaker (the caller turns that call into a card), else null.
   */
  recordVerdict(denied: boolean): AutoModePause | null {
    this.recent.push(denied);
    if (this.recent.length > AUTO_MODE_BREAKER.WINDOW) this.recent.shift();
    this.consecutive = denied ? this.consecutive + 1 : 0;
    if (!denied || this.pause) return null;

    const inWindow = this.recentDenials;
    if (this.consecutive >= AUTO_MODE_BREAKER.CONSECUTIVE_DENIALS) {
      this.pause = {
        trippedBy: "consecutive",
        denials: this.consecutive,
        reason: `auto mode is paused: the classifier denied ${this.consecutive} actions in a row`,
      };
    } else if (inWindow >= AUTO_MODE_BREAKER.WINDOW_DENIALS) {
      this.pause = {
        trippedBy: "window",
        denials: inWindow,
        reason:
          `auto mode is paused: the classifier denied ${inWindow} of the last ` +
          `${this.recent.length} actions`,
      };
    }
    return this.pause;
  }

  /**
   * A person allowed a call auto mode had put to them. That is the say-so
   * the breaker waits for: both counters start over and auto mode resumes.
   */
  recordUserAllowed(): void {
    this.consecutive = 0;
    if (this.pause) {
      this.pause = null;
      this.recent = [];
    }
  }

  recordSpend(dollars: number | null | undefined): void {
    this.calls++;
    if (typeof dollars === "number" && Number.isFinite(dollars)) this.spentDollars += dollars;
  }
}

/**
 * The session ledger — the only stateful component in the design.
 *
 * It answers two questions the API cannot, because only this process sees the
 * whole session: what has this agent already been given, and how much room is
 * left?
 *
 * Two rules matter more than the mechanism:
 *  - A skip is always announced. An empty result reads to an agent as "nothing
 *    exists", and it will act on that.
 *  - Truncation is loud. Naming what was withheld lets the agent decide whether
 *    to spend a fetch on it; silently dropping it is a lie it will build on.
 */

export interface LedgerEntry {
  title: string;
  tokens: number;
  turn: number;
}

export interface Budget {
  core: number;
  perSearch: number;
  session: number;
}

export const DEFAULT_BUDGET: Budget = {
  core: 800,
  // Generous because a container with no cached rules returns raw prose
  // (~4k tokens). That is a few percent of a modern context window — dilution
  // is the real risk here, not capacity.
  perSearch: 4000,
  session: 8000,
};

export class Ledger {
  private readonly sent = new Map<string, LedgerEntry>();
  private spent = 0;
  private turn = 0;

  constructor(private readonly budget: Budget = DEFAULT_BUDGET) {}

  nextTurn(): void {
    this.turn += 1;
  }

  has(id: string): boolean {
    return this.sent.has(id);
  }

  entry(id: string): LedgerEntry | undefined {
    return this.sent.get(id);
  }

  remaining(): number {
    return Math.max(0, this.budget.session - this.spent);
  }

  /** Record a payload as delivered. */
  record(id: string, title: string, tokens: number): void {
    if (this.sent.has(id)) return;
    this.sent.set(id, { title, tokens, turn: this.turn });
    this.spent += tokens;
  }

  /** Can a payload of this size still be delivered? */
  fits(tokens: number, scope: keyof Budget = "session"): boolean {
    if (scope !== "session" && tokens > this.budget[scope]) return false;
    return this.spent + tokens <= this.budget.session;
  }

  summary(): string {
    return `${this.sent.size} container(s) loaded, ~${this.spent}/${this.budget.session} tokens used this session.`;
  }
}

/** Rough token estimate. Matches the server's own heuristic. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

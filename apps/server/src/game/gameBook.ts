import { randomUUID } from 'node:crypto';
import { formatMoney } from '@pokerclause/shared';
import { stringify } from 'yaml';
import type { GameReportSummary } from '../db/store.js';

/**
 * The bookkeeping for one game at one table — every chip that comes onto
 * the table (buy-ins, rebuys) or leaves it (cash-outs), and every hand's
 * result per player — kept the way a home game keeps its ledger: book
 * money in and out as it happens, net everyone (cash-outs + chips still
 * on the table − buy-ins), settle once at the end. See DECISIONS.md.
 *
 * The book keeps its OWN running chip count for every player (buy-ins −
 * cash-outs + hand results) rather than reading stacks off the table, so
 * it can be checked against the table independently: after every hand
 * `reconcile` compares the two, and the report states whether they agree.
 *
 * One book per game: a table starts a new one when it's reset (that ends
 * the game — everyone is cashed out) and closes it when the table is
 * terminated or empties. All amounts are integer cents.
 */

export type PlayerKind = 'registered' | 'guest' | 'bot';
export type MovementType = 'buy-in' | 'rebuy' | 'cash-out';

interface BookPlayer {
  key: string;
  name: string;
  kind: PlayerKind;
  buyIns: number;
  buyInCount: number;
  cashOuts: number;
  /** The book's own running count of this player's chips on the table. */
  chips: number;
  seated: boolean;
  handsPlayed: number;
  handsWon: number;
  biggestPotWon: number;
}

interface Movement {
  at: Date;
  /** Hands completed when this happened — "after hand #N". */
  afterHand: number;
  key: string;
  type: MovementType;
  amount: number;
  note: string | null;
}

export interface HandResultInput {
  number: number;
  handId: string;
  startedAt: Date;
  endedAt: Date;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  board: readonly string[];
  pot: number;
  /** Net chips won (+) or lost (−) this hand, for every player dealt in. Must sum to zero. */
  results: ReadonlyMap<string, number>;
  winners: readonly { key: string; amount: number; handName: string | null }[];
}

interface HandRecord extends HandResultInput {
  reconciled: boolean | null;
}

interface VoidedHand {
  number: number;
  at: Date;
  reason: string;
}

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

/** The "computer players" pseudo-party in settlements: bot chips aren't anyone's money, so whatever humans won from (or lost to) bots nets against this one counterparty. */
const BOTS_PARTY = 'Computer players';

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function signed(cents: number): string {
  return cents > 0 ? `+${formatMoney(cents)}` : formatMoney(cents);
}

/**
 * Who pays whom, the way home games settle up: net everyone, then
 * repeatedly have the biggest loser pay the biggest winner the smaller of
 * their two amounts — each payment clears at least one person, so it
 * takes at most n−1 payments. Ties break on name so the result is stable.
 */
export function settle(nets: ReadonlyMap<string, number>): Settlement[] {
  const owe = [...nets].filter(([, n]) => n < 0).map(([name, n]) => ({ name, left: -n }));
  const owed = [...nets].filter(([, n]) => n > 0).map(([name, n]) => ({ name, left: n }));
  const byBiggest = (a: { name: string; left: number }, b: { name: string; left: number }): number => b.left - a.left || a.name.localeCompare(b.name);
  const out: Settlement[] = [];
  for (;;) {
    owe.sort(byBiggest);
    owed.sort(byBiggest);
    const debtor = owe[0];
    const creditor = owed[0];
    if (!debtor || !creditor || debtor.left <= 0 || creditor.left <= 0) break;
    const amount = Math.min(debtor.left, creditor.left);
    out.push({ from: debtor.name, to: creditor.name, amount });
    debtor.left -= amount;
    creditor.left -= amount;
    if (debtor.left === 0) owe.shift();
    if (creditor.left === 0) owed.shift();
  }
  return out;
}

export class GameBook {
  readonly id = randomUUID();
  readonly startedAt: Date;
  endedAt: Date | null = null;
  endReason: string | null = null;
  updatedAt: Date;
  private readonly players = new Map<string, BookPlayer>();
  private readonly movements: Movement[] = [];
  private readonly hands: HandRecord[] = [];
  private readonly voided: VoidedHand[] = [];

  constructor(
    readonly tableId: string,
    public tableName: string,
    readonly gameNumber: number,
    now: Date,
  ) {
    this.startedAt = now;
    this.updatedAt = now;
  }

  get handsPlayed(): number {
    return this.hands.length;
  }

  get lastHand(): HandRecord | null {
    return this.hands[this.hands.length - 1] ?? null;
  }

  get isFinal(): boolean {
    return this.endedAt !== null;
  }

  private player(key: string, name: string, kind: PlayerKind): BookPlayer {
    let p = this.players.get(key);
    if (!p) {
      p = { key, name, kind, buyIns: 0, buyInCount: 0, cashOuts: 0, chips: 0, seated: false, handsPlayed: 0, handsWon: 0, biggestPotWon: 0 };
      this.players.set(key, p);
    }
    p.name = name;
    return p;
  }

  buyIn(key: string, name: string, kind: PlayerKind, amount: number, type: 'buy-in' | 'rebuy', at: Date, note: string | null = null): void {
    if (amount <= 0) return;
    const p = this.player(key, name, kind);
    p.buyIns += amount;
    p.buyInCount += 1;
    p.chips += amount;
    p.seated = true;
    this.movements.push({ at, afterHand: this.handsPlayed, key, type, amount, note });
    this.updatedAt = at;
  }

  cashOut(key: string, amount: number, at: Date, note: string): void {
    const p = this.players.get(key);
    if (!p) return;
    p.cashOuts += amount;
    p.chips -= amount;
    p.seated = false;
    this.movements.push({ at, afterHand: this.handsPlayed, key, type: 'cash-out', amount, note });
    this.updatedAt = at;
  }

  recordHand(hand: HandResultInput): void {
    for (const [key, net] of hand.results) {
      const p = this.players.get(key);
      if (!p) continue;
      p.chips += net;
      p.handsPlayed += 1;
    }
    const wonBy = new Map<string, number>();
    for (const w of hand.winners) wonBy.set(w.key, (wonBy.get(w.key) ?? 0) + w.amount);
    for (const [key, amount] of wonBy) {
      const p = this.players.get(key);
      if (!p) continue;
      p.handsWon += 1;
      p.biggestPotWon = Math.max(p.biggestPotWon, amount);
    }
    this.hands.push({ ...hand, reconciled: null });
    this.updatedAt = hand.endedAt;
  }

  /** A hand cut short by a reset/terminate: nobody wins or loses anything in it — every chip bet comes back in the cash-outs that follow. */
  voidHand(number: number, at: Date, reason: string): void {
    this.voided.push({ number, at, reason });
    this.updatedAt = at;
  }

  /**
   * Checks the book's own chip count for every seated player against what
   * the table actually holds for them. Records the outcome on the last
   * hand; returns the players that disagree (empty = balanced).
   */
  reconcile(actual: ReadonlyMap<string, number>): string[] {
    const mismatched: string[] = [];
    for (const p of this.players.values()) {
      const real = actual.get(p.key);
      if (real === undefined) {
        if (p.seated && p.chips !== 0) mismatched.push(p.name);
        continue;
      }
      if (real !== p.chips) mismatched.push(p.name);
    }
    const last = this.lastHand;
    if (last) last.reconciled = mismatched.length === 0;
    return mismatched;
  }

  finalize(at: Date, reason: string): void {
    if (this.endedAt) return;
    this.endedAt = at;
    this.endReason = reason;
    this.updatedAt = at;
  }

  /** Display names made unique ("Alice", "Alice (2)") so every line of the report is unambiguous. */
  private labels(): Map<string, string> {
    const out = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const p of this.players.values()) {
      const n = (seen.get(p.name) ?? 0) + 1;
      seen.set(p.name, n);
      out.set(p.key, n === 1 ? p.name : `${p.name} (${String(n)})`);
    }
    return out;
  }

  private net(p: BookPlayer): number {
    return p.cashOuts + p.chips - p.buyIns;
  }

  /**
   * The game's headline numbers and final standings, in cents — what the
   * store keeps in structured columns (game_reports, game_report_players)
   * so the admin dashboard can list, sort and search games without
   * parsing YAML. Same ranking and labels as the report's standings.
   */
  summary(): GameReportSummary {
    const label = this.labels();
    const players = [...this.players.values()];
    const ranked = [...players].sort((a, b) => this.net(b) - this.net(a) || b.handsWon - a.handsWon || (label.get(a.key) ?? a.key).localeCompare(label.get(b.key) ?? b.key));
    const totalBoughtIn = players.reduce((s, p) => s + p.buyIns, 0);
    const totalCashedOut = players.reduce((s, p) => s + p.cashOuts, 0);
    const stillOnTable = players.reduce((s, p) => s + p.chips, 0);
    const last = this.lastHand;
    return {
      gameNumber: this.gameNumber,
      stakes: last ? `${formatMoney(last.smallBlind)}/${formatMoney(last.bigBlind)}` : '',
      playerCount: players.filter((p) => p.kind !== 'bot').length,
      totalBoughtIn,
      totalCashedOut,
      stillOnTable,
      booksBalance: players.reduce((s, p) => s + this.net(p), 0) === 0 && totalBoughtIn === totalCashedOut + stillOnTable,
      players: ranked.map((p, i) => ({
        rank: i + 1,
        playerName: label.get(p.key) ?? p.key,
        // A guest's too — it's the id of their guest record (see GuestPlayerRecord), so the owner sees their games under them.
        userId: p.kind === 'bot' ? null : p.key,
        playerType: p.kind,
        boughtIn: p.buyIns,
        buyInCount: p.buyInCount,
        cashedOut: p.cashOuts,
        onTable: p.chips,
        net: this.net(p),
        handsPlayed: p.handsPlayed,
        handsWon: p.handsWon,
      })),
    };
  }

  /** Everything in the report, as plain data — the YAML file is this, serialized; the PDF is rendered from it. */
  toReport(now: Date = new Date()): GameReport {
    const label = this.labels();
    const name = (key: string): string => label.get(key) ?? key;
    const players = [...this.players.values()];
    const ranked = [...players].sort((a, b) => this.net(b) - this.net(a) || b.handsWon - a.handsWon || name(a.key).localeCompare(name(b.key)));

    const humanNets = new Map<string, number>();
    let botsNet = 0;
    for (const p of players) {
      if (p.kind === 'bot') botsNet += this.net(p);
      else if (this.net(p) !== 0) humanNets.set(name(p.key), this.net(p));
    }
    if (botsNet !== 0) humanNets.set(BOTS_PARTY, botsNet);

    const totalBuyIns = players.reduce((s, p) => s + p.buyIns, 0);
    const totalCashOuts = players.reduce((s, p) => s + p.cashOuts, 0);
    const onTable = players.reduce((s, p) => s + p.chips, 0);
    const netSum = players.reduce((s, p) => s + this.net(p), 0);
    const last = this.lastHand;
    const reconciledHands = this.hands.filter((h) => h.reconciled === true).length;
    const unreconciled = this.hands.filter((h) => h.reconciled === false).map((h) => h.number);

    return {
      report: 'pokerclause game report',
      format_version: 1,
      game: {
        id: this.id,
        game_number_at_table: this.gameNumber,
        table: { id: this.tableId, name: this.tableName },
        status: this.isFinal ? 'final' : 'live',
        ...(this.endReason ? { ended_because: this.endReason } : {}),
        started_at: iso(this.startedAt),
        ...(this.endedAt ? { ended_at: iso(this.endedAt) } : {}),
        report_generated_at: iso(now),
        as_of: last ? `after hand #${String(last.number)} (${iso(last.endedAt)})` : 'before the first hand',
        hands_played: this.handsPlayed,
        ...(this.voided.length > 0 ? { hands_voided: this.voided.map((v) => ({ hand: v.number, at: iso(v.at), reason: v.reason })) } : {}),
        currency: 'USD',
      },
      summary: {
        players: players.filter((p) => p.kind !== 'bot').length,
        computer_players: players.filter((p) => p.kind === 'bot').length,
        total_bought_in: formatMoney(totalBuyIns),
        total_cashed_out: formatMoney(totalCashOuts),
        still_on_table: formatMoney(onTable),
        books_balance: netSum === 0 && totalBuyIns === totalCashOuts + onTable,
        balance_check: `bought in ${formatMoney(totalBuyIns)} = cashed out ${formatMoney(totalCashOuts)} + on table ${formatMoney(onTable)}`,
        hands_reconciled_with_table: `${String(reconciledHands)} of ${String(this.handsPlayed)}`,
        ...(unreconciled.length > 0 ? { hands_not_reconciled: unreconciled } : {}),
      },
      standings: ranked.map((p, i) => ({
        rank: i + 1,
        player: name(p.key),
        type: p.kind === 'bot' ? 'computer (play chips)' : p.kind === 'guest' ? 'guest' : 'registered',
        bought_in: formatMoney(p.buyIns),
        buy_in_count: p.buyInCount,
        cashed_out: formatMoney(p.cashOuts),
        on_table: formatMoney(p.chips),
        net_result: signed(this.net(p)),
        hands_played: p.handsPlayed,
        hands_won: p.handsWon,
        biggest_pot_won: formatMoney(p.biggestPotWon),
      })),
      settlements: {
        basis: this.isFinal ? 'final results' : 'if the game ended now (players still seated count their chips on the table)',
        method: 'biggest loser pays biggest winner the smaller amount, repeated — at most one payment fewer than the number of people involved',
        payments: settle(humanNets).map((s) => ({ from: s.from, to: s.to, amount: formatMoney(s.amount) })),
        ...(botsNet !== 0 ? { note: `"${BOTS_PARTY}" stands for chips won from or lost to computer players — play chips, not anyone's money.` } : {}),
      },
      money_movements: this.movements.map((m) => ({
        at: iso(m.at),
        after_hand: m.afterHand,
        player: name(m.key),
        type: m.type,
        amount: formatMoney(m.amount),
        ...(m.note ? { note: m.note } : {}),
      })),
      hands: this.hands.map((h) => ({
        hand: h.number,
        started_at: iso(h.startedAt),
        ended_at: iso(h.endedAt),
        blinds: `${formatMoney(h.smallBlind)}/${formatMoney(h.bigBlind)}${h.ante > 0 ? ` ante ${formatMoney(h.ante)}` : ''}`,
        pot: formatMoney(h.pot),
        board: h.board.length > 0 ? h.board.join(' ') : '(no flop)',
        winners: h.winners.map((w) => ({ player: name(w.key), won: formatMoney(w.amount), ...(w.handName ? { with: w.handName } : {}) })),
        results: Object.fromEntries([...h.results].filter(([, net]) => net !== 0).map(([key, net]) => [name(key), signed(net)])),
        reconciled_with_table: h.reconciled,
      })),
    };
  }

  toYaml(now: Date = new Date()): string {
    return stringify(this.toReport(now), { lineWidth: 0 });
  }
}

export interface GameReport {
  report: string;
  format_version: number;
  game: {
    id: string;
    game_number_at_table: number;
    table: { id: string; name: string };
    status: 'live' | 'final';
    ended_because?: string;
    started_at: string;
    ended_at?: string;
    report_generated_at: string;
    as_of: string;
    hands_played: number;
    hands_voided?: { hand: number; at: string; reason: string }[];
    currency: string;
  };
  summary: {
    players: number;
    computer_players: number;
    total_bought_in: string;
    total_cashed_out: string;
    still_on_table: string;
    books_balance: boolean;
    balance_check: string;
    hands_reconciled_with_table: string;
    hands_not_reconciled?: number[];
  };
  standings: {
    rank: number;
    player: string;
    type: string;
    bought_in: string;
    buy_in_count: number;
    cashed_out: string;
    on_table: string;
    net_result: string;
    hands_played: number;
    hands_won: number;
    biggest_pot_won: string;
  }[];
  settlements: { basis: string; method: string; payments: { from: string; to: string; amount: string }[]; note?: string };
  money_movements: { at: string; after_hand: number; player: string; type: MovementType; amount: string; note?: string }[];
  hands: {
    hand: number;
    started_at: string;
    ended_at: string;
    blinds: string;
    pot: string;
    board: string;
    winners: { player: string; won: string; with?: string }[];
    results: Record<string, string>;
    reconciled_with_table: boolean | null;
  }[];
}

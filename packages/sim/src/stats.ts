import { createDefaultEvaluator, rankIndex, type Card, type GameEvent, type TableState } from '@pokerclause/engine';

const evaluator = createDefaultEvaluator();

/** Theoretical probability of each 7-card hand class (C(52,7) = 133,784,560 combinations). */
export const THEORETICAL_HAND_CLASS_FREQUENCY: Record<string, number> = {
  'straight flush': 0.000311,
  'four of a kind': 0.00168,
  'full house': 0.026,
  flush: 0.0303,
  straight: 0.0462,
  'three of a kind': 0.0483,
  'two pairs': 0.235,
  'one pair': 0.4382,
  'high card': 0.1741,
};

export interface StatCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** Raw accumulated counts, serializable across a worker_threads boundary for merging. */
export interface StatsSnapshot {
  handClassCounts: Record<string, number>;
  handClassTotal: number;
  boardCardCounts: Record<string, number>;
  boardCardTotal: number;
  seatRankCounts: Record<number, number[]>;
  /** Indexed by physical seatId (0..8): observed times that seat was the button. */
  buttonObserved: number[];
  /**
   * Indexed by physical seatId: sum of 1/ringSize over every hand that
   * seat was occupied for — i.e. the number of times it "should" have
   * been button under a uniform-over-the-current-ring assumption. This
   * is what makes the fairness check robust to churn constantly changing
   * ring size and membership between hands; a naive "index within the
   * current ring" pooled mean is NOT (see DECISIONS in this file's git
   * history / sim README).
   */
  buttonExpected: number[];
}

export class StatsCollector {
  private readonly handClassCounts = new Map<string, number>();
  private handClassTotal = 0;

  private readonly boardCardCounts = new Map<Card, number>();
  private boardCardTotal = 0;

  private readonly seatRankCounts = new Map<number, number[]>(); // seatId -> 13-bucket histogram
  private readonly buttonObserved = new Array<number>(9).fill(0);
  private readonly buttonExpected = new Array<number>(9).fill(0);

  observeHandComplete(finalState: TableState, events: readonly GameEvent[], isFirstHandOfTable = false): void {
    const revealedSeats = new Set<number>();
    for (const e of events) {
      if (e.type === 'showdown-reveal') revealedSeats.add(e.seatId);
    }
    if (revealedSeats.size > 0 && finalState.board.length === 5) {
      for (const seatId of revealedSeats) {
        const seat = finalState.seats.find((s) => s.seatId === seatId);
        if (!seat || seat.holeCards.length !== 2) continue;
        const evaluated = evaluator.evaluate([...finalState.board, ...seat.holeCards]);
        const key = evaluated.name.toLowerCase();
        this.handClassCounts.set(key, (this.handClassCounts.get(key) ?? 0) + 1);
        this.handClassTotal += 1;
      }
    }

    if (finalState.board.length > 0) {
      for (const card of finalState.board) {
        this.boardCardCounts.set(card, (this.boardCardCounts.get(card) ?? 0) + 1);
        this.boardCardTotal += 1;
      }
    }

    for (const e of events) {
      if (e.type !== 'cards-dealt') continue;
      for (const deal of e.deals) {
        let hist = this.seatRankCounts.get(deal.seatId);
        if (!hist) {
          hist = new Array<number>(13).fill(0);
          this.seatRankCounts.set(deal.seatId, hist);
        }
        for (const card of deal.cards) {
          const idx = rankIndex(card);
          hist[idx] = (hist[idx] ?? 0) + 1;
        }
      }
    }

    // A fresh table's first hand always seats the button at the lowest
    // occupied seatId (a one-time bootstrap choice, not a rotation
    // outcome — see engine DECISIONS.md #3) and would otherwise bias this
    // fairness check toward low seat numbers.
    if (finalState.phase === 'hand-complete' && !isFirstHandOfTable) {
      const occupied = finalState.seats.filter((s) => s.status !== 'empty');
      if (occupied.length > 1) {
        const share = 1 / occupied.length;
        for (const s of occupied) {
          this.buttonExpected[s.seatId] = (this.buttonExpected[s.seatId] ?? 0) + share;
        }
        this.buttonObserved[finalState.buttonSeat] = (this.buttonObserved[finalState.buttonSeat] ?? 0) + 1;
      }
    }
  }

  toSnapshot(): StatsSnapshot {
    return {
      handClassCounts: Object.fromEntries(this.handClassCounts),
      handClassTotal: this.handClassTotal,
      boardCardCounts: Object.fromEntries(this.boardCardCounts),
      boardCardTotal: this.boardCardTotal,
      seatRankCounts: Object.fromEntries([...this.seatRankCounts].map(([k, v]) => [k, [...v]])),
      buttonObserved: [...this.buttonObserved],
      buttonExpected: [...this.buttonExpected],
    };
  }

  /** Merges another worker's raw counts into this collector. */
  mergeSnapshot(snap: StatsSnapshot): void {
    for (const [k, v] of Object.entries(snap.handClassCounts)) {
      this.handClassCounts.set(k, (this.handClassCounts.get(k) ?? 0) + v);
    }
    this.handClassTotal += snap.handClassTotal;
    for (const [k, v] of Object.entries(snap.boardCardCounts)) {
      this.boardCardCounts.set(k as Card, (this.boardCardCounts.get(k as Card) ?? 0) + v);
    }
    this.boardCardTotal += snap.boardCardTotal;
    for (const [k, v] of Object.entries(snap.seatRankCounts)) {
      const seatId = Number(k);
      const existing = this.seatRankCounts.get(seatId) ?? new Array<number>(13).fill(0);
      for (let i = 0; i < 13; i++) existing[i] = (existing[i] ?? 0) + (v[i] ?? 0);
      this.seatRankCounts.set(seatId, existing);
    }
    for (let i = 0; i < 9; i++) {
      this.buttonObserved[i] = (this.buttonObserved[i] ?? 0) + (snap.buttonObserved[i] ?? 0);
      this.buttonExpected[i] = (this.buttonExpected[i] ?? 0) + (snap.buttonExpected[i] ?? 0);
    }
  }

  private chiSquare(observed: number[], expectedFractions: number[], total: number): number {
    let stat = 0;
    for (let i = 0; i < observed.length; i++) {
      const expected = expectedFractions[i]! * total;
      if (expected <= 0) continue;
      stat += (observed[i]! - expected) ** 2 / expected;
    }
    return stat;
  }

  report(): StatCheckResult[] {
    const results: StatCheckResult[] = [];

    if (this.handClassTotal > 0) {
      const keys = Object.keys(THEORETICAL_HAND_CLASS_FREQUENCY);
      const observed = keys.map((k) => this.handClassCounts.get(k) ?? 0);
      const expectedFractions = keys.map((k) => THEORETICAL_HAND_CLASS_FREQUENCY[k]!);
      const stat = this.chiSquare(observed, expectedFractions, this.handClassTotal);
      // df = 8, chi-square critical value at p=0.001 is 26.13; use a wide
      // margin since sample-dependent bot behavior (fold rates skew which
      // hands even reach showdown) isn't a uniform random 7-card draw.
      const threshold = 60;
      results.push({
        name: 'hand-class-frequency',
        passed: stat < threshold,
        detail: `chi-square=${stat.toFixed(2)} (threshold ${String(threshold)}), n=${String(this.handClassTotal)}, counts=${JSON.stringify(Object.fromEntries(this.handClassCounts))}`,
      });
    }

    if (this.boardCardTotal > 0) {
      const cards = [...this.boardCardCounts.keys()];
      const observed = cards.map((c) => this.boardCardCounts.get(c)!);
      const expectedFractions = cards.map(() => 1 / 52);
      const stat = this.chiSquare(observed, expectedFractions, this.boardCardTotal);
      // df=51, p=0.001 critical value ~ 92.7; generous margin for run-to-run noise.
      const threshold = 140;
      results.push({
        name: 'board-card-frequency',
        passed: stat < threshold,
        detail: `chi-square=${stat.toFixed(2)} (threshold ${String(threshold)}), n=${String(this.boardCardTotal)}, distinctCards=${String(cards.length)}`,
      });
    }

    for (const [seatId, hist] of this.seatRankCounts) {
      const total = hist.reduce((a, b) => a + b, 0);
      if (total < 200) continue; // not enough samples for this seat to mean anything
      const stat = this.chiSquare(hist, new Array<number>(13).fill(1 / 13), total);
      // df=12, p=0.001 critical value ~ 32.9.
      const threshold = 60;
      results.push({
        name: `seat-${String(seatId)}-rank-frequency`,
        passed: stat < threshold,
        detail: `chi-square=${stat.toFixed(2)} (threshold ${String(threshold)}), n=${String(total)}`,
      });
    }

    const totalExpected = this.buttonExpected.reduce((a, b) => a + b, 0);
    if (totalExpected > 30) {
      // Occupancy-weighted chi-square: each seat's expected button count is
      // the sum of 1/ringSize over every hand it was occupied for, which
      // stays correct even as churn constantly changes ring size and
      // membership between hands (unlike a naive pooled "index within the
      // current ring" mean).
      const stat = this.chiSquare(
        this.buttonObserved,
        this.buttonExpected.map((e) => e / totalExpected),
        totalExpected,
      );
      // df up to 8; p=0.001 critical value ~26.1. Generous margin for noise.
      const threshold = 50;
      results.push({
        name: 'button-position-uniformity',
        passed: stat < threshold,
        detail: `chi-square=${stat.toFixed(2)} (threshold ${String(threshold)}), observed=${JSON.stringify(this.buttonObserved)}, expected=${JSON.stringify(this.buttonExpected.map((e) => Math.round(e)))}`,
      });
    }

    return results;
  }
}

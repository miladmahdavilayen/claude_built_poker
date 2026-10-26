import type { Card } from '@pokerclause/engine';
import type { ProjectedGameEvent } from '@pokerclause/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TIMINGS } from '../animationTimings.js';
import { formatChips } from '../chips.js';
import type { SeatPosition } from '../seatLayout.js';
import { playSplitPotSound, playWinChimeSound } from '../sound.js';
import { buildPotAnnouncements, splitLogLine, type PotAnnouncement, type PotAward } from '../splitPot.js';
import type { PotAnimator } from '../table3d/TableScene3D.js';
import { ChipStack } from './ChipStack.js';

/** What the seats show while a split plays out (see Seat.tsx). */
export interface SplitSeatEffects {
  /** Glowing: this pot's winners. */
  winners: ReadonlySet<number>;
  /** Dimmed: everyone else still in the hand. */
  dimmed: ReadonlySet<number>;
  /** The winning cards (each winner's best five), raised. */
  cards: ReadonlySet<string>;
  /** Chips each winner has coming that haven't landed yet — their stack shows this much less, then counts up. */
  pending: ReadonlyMap<number, number>;
}

export const NO_SPLIT_EFFECTS: SplitSeatEffects = { winners: new Set(), dimmed: new Set(), cards: new Set(), pending: new Map() };

interface Sequence {
  id: number;
  anns: PotAnnouncement[];
  awards: PotAward[];
  inHand: number[];
  /** Each winner's chips across every pot, still to land. */
  pending: Map<number, number>;
}

interface FloatLabel {
  id: string;
  seatId: number;
  amount: number;
  delayMs: number;
}

interface Pile {
  id: string;
  amount: number;
  toLeft: number;
  toTop: number;
  spread: number;
  delayMs: number;
}

/**
 * The split-pot announcement. When the server's awards show any pot this
 * hand going to two or more players, every pot is announced one at a time
 * in the server's award order (side pots first, then the main pot): a
 * banner over the pot that says it was split, who shared it, with what
 * and exactly how much each got; the pot dividing into one pile per
 * winner and each pile sliding to its winner; a rising "+$X" from each;
 * the winners glowing and everyone else dimmed; and each winner's stack
 * counting up as their chips land. A hand where every pot has one winner
 * never comes here — the usual WinCelebration plays, unchanged.
 *
 * Nothing waits on it: a new hand dealt mid-announcement ends it at once
 * (the hand log already has the result), and a tap or click on the banner
 * skips to the end.
 */
export function SplitPotAnnouncement({
  events,
  nameOf,
  board,
  inHandSeatIds,
  positions,
  potPosition,
  bannerAnchor,
  potAnimator,
  reduceMotion,
  slow,
  onEffects,
  onLog,
}: {
  events: readonly ProjectedGameEvent[];
  nameOf: (seatId: number) => string;
  board: readonly Card[];
  /** Seats that were dealt into this hand (for dimming the non-winners). */
  inHandSeatIds: readonly number[];
  /** Seat positions, % of the felt. */
  positions: readonly SeatPosition[];
  /** The pot, % of the felt. */
  potPosition: { left: number; top: number };
  /** Where the banner's bottom edge goes — just above the board, so it never hides the winning cards. */
  bannerAnchor: { left: number; top: number };
  /** On the 3D table, the scene moves its own chips; on the 2D table this draws them. */
  potAnimator: PotAnimator | null;
  reduceMotion: boolean;
  slow: boolean;
  onEffects: (effects: SplitSeatEffects) => void;
  /** Plain-text lines for the chat ("Alice and Bob split the pot, $5 each"). */
  onLog: (lines: string[]) => void;
}): React.JSX.Element | null {
  const [current, setCurrent] = useState<{ seq: Sequence; index: number } | null>(null);
  const [floats, setFloats] = useState<FloatLabel[]>([]);
  const [piles, setPiles] = useState<Pile[]>([]);
  const queueRef = useRef<Sequence[]>([]);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const lastEventsRef = useRef<readonly ProjectedGameEvent[] | null>(null);
  const seqIdRef = useRef(0);
  const pendingRef = useRef(new Map<number, number>());
  const playingRef = useRef(false);
  const latest = useRef({ nameOf, board, inHandSeatIds, potAnimator, reduceMotion, slow, onEffects, onLog });
  latest.current = { nameOf, board, inHandSeatIds, potAnimator, reduceMotion, slow, onEffects, onLog };

  const later = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timersRef.current.delete(t);
      fn();
    }, ms);
    timersRef.current.add(t);
  }, []);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current.clear();
  }, []);

  /** Everything still to come lands at once. */
  const finishAll = useCallback(() => {
    clearTimers();
    queueRef.current = [];
    pendingRef.current = new Map();
    playingRef.current = false;
    latest.current.potAnimator?.finish();
    setCurrent(null);
    setFloats([]);
    setPiles([]);
    latest.current.onEffects(NO_SPLIT_EFFECTS);
  }, [clearTimers]);

  const play = useCallback(
    (seq: Sequence, index: number) => {
      const ann = seq.anns[index];
      if (!ann) {
        // That was the last pot: back to normal, and on to the next hand's split if one queued up.
        pendingRef.current = new Map();
        playingRef.current = false;
        setCurrent(null);
        setPiles([]);
        latest.current.onEffects(NO_SPLIT_EFFECTS);
        const next = queueRef.current.shift();
        if (next) play(next, 0);
        return;
      }
      const { reduceMotion: still, slow: isSlow, potAnimator: anim } = latest.current;
      const k = isSlow ? TIMINGS.slowFactor : 1;
      const pileMs = still ? 0 : (ann.split ? TIMINGS.splitPileMs : 0) * k;
      const slideMs = still ? 0 : TIMINGS.splitSlideMs * k;
      const staggerMs = still ? 0 : TIMINGS.splitStaggerMs * k;
      if (index === 0) {
        playingRef.current = true;
        pendingRef.current = new Map(seq.pending);
      }
      setCurrent({ seq, index });
      if (ann.split) playSplitPotSound(ann.winners.length);
      else playWinChimeSound();

      const award = seq.awards[index]!;
      const winners = new Set(ann.winners.map((w) => w.seatId));
      const cards = new Set<string>(award.winners.flatMap((w) => w.bestFive ?? []));
      const emit = (): void =>
        latest.current.onEffects({
          winners,
          dimmed: new Set(seq.inHand.filter((id) => !winners.has(id))),
          cards,
          pending: new Map(pendingRef.current),
        });
      emit();

      // The chips: the 3D scene moves its own; on the 2D table, DOM piles.
      if (anim) {
        anim.distribute(ann.winners, { pileMs, slideMs, staggerMs });
      } else {
        setPiles(
          ann.winners.map((w, i) => {
            const pos = positions.find((p) => p.seatId === w.seatId);
            return {
              id: `${String(seq.id)}-${String(index)}-${String(w.seatId)}`,
              amount: w.amount,
              toLeft: pos?.left ?? potPosition.left,
              toTop: pos?.top ?? potPosition.top,
              spread: ann.winners.length > 1 ? (i - (ann.winners.length - 1) / 2) * 46 : 0,
              delayMs: pileMs + i * staggerMs,
            };
          }),
        );
      }
      // Each winner's "+$X" and stack count-up, as their pile lands.
      setFloats((prev) => [
        ...prev,
        ...ann.winners.map((w, i) => ({ id: `${String(seq.id)}-${String(index)}-${String(w.seatId)}`, seatId: w.seatId, amount: w.amount, delayMs: pileMs + i * staggerMs + slideMs * 0.6 })),
      ]);
      ann.winners.forEach((w, i) => {
        later(pileMs + i * staggerMs + slideMs, () => {
          const left = (pendingRef.current.get(w.seatId) ?? 0) - w.amount;
          if (left > 0) pendingRef.current.set(w.seatId, left);
          else pendingRef.current.delete(w.seatId);
          emit();
        });
      });
      const bannerMs = TIMINGS.splitBannerMs * k;
      later(bannerMs, () => {
        setFloats((prev) => prev.filter((f) => !f.id.startsWith(`${String(seq.id)}-${String(index)}-`)));
        play(seq, index + 1);
      });
    },
    [later, positions, potPosition.left, potPosition.top],
  );

  /** Announces a hand's pot awards — if any pot in them was split. */
  const announce = useCallback(
    (awards: readonly PotAward[]) => {
      const { nameOf: name, board: b, inHandSeatIds: inHand } = latest.current;
      const anns = buildPotAnnouncements(awards, name, b);
      if (!anns) return;
      latest.current.onLog(awards.map((a) => splitLogLine(a, name, awards.length)).filter((l): l is string => l !== null));
      // The chips each winner has coming, across every pot: their stack shows that much less until each lands.
      const pending = new Map<number, number>();
      if (!latest.current.reduceMotion) for (const a of awards) for (const w of a.winners) pending.set(w.seatId, (pending.get(w.seatId) ?? 0) + w.amount);
      const seq: Sequence = { id: ++seqIdRef.current, anns, awards: [...awards], inHand: [...inHand], pending };
      // Never two at once: one still playing, this one waits its turn.
      if (playingRef.current) {
        queueRef.current.push(seq);
        return;
      }
      play(seq, 0);
    },
    [play],
  );

  useEffect(() => {
    if (events === lastEventsRef.current) return;
    lastEventsRef.current = events;
    // A new hand dealt: whatever's still announcing ends now (the hand log has it all).
    if (events.some((e) => e.type === 'hand-started')) finishAll();
    announce(events.filter((e): e is Extract<ProjectedGameEvent, { type: 'pot-awarded' }> => e.type === 'pot-awarded'));
  }, [events, finishAll, announce]);

  // Dev only: `__splitPot([{ potIndex: 0, winners: [{ seatId: 0, amount: 500 }, { seatId: 3, amount: 500 }] }])`
  // in the console announces those awards at a real table — the same path a real showdown takes.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __splitPot?: (awards: PotAward[]) => void };
    w.__splitPot = (awards) => announce(awards);
    return () => {
      delete w.__splitPot;
    };
  }, [announce]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  if (!current) return null;
  const ann = current.seq.anns[current.index]!;
  const total = current.seq.anns.length;
  return (
    <>
      <div
        className={`split-pot-banner${ann.split ? '' : ' split-pot-banner--single'}${reduceMotion ? ' split-pot-banner--still' : ''}`}
        data-testid="split-pot-banner"
        data-pot-index={ann.potIndex}
        role="status"
        aria-live="polite"
        // Kept on the felt: never so high its top would go off it.
        style={{ left: `${String(bannerAnchor.left)}%`, top: `max(120px, ${String(bannerAnchor.top)}%)` }}
        onClick={finishAll}
        title="Tap to skip"
      >
        {ann.label && (
          <div className="split-pot-label">
            {ann.label}
            {total > 1 && <span className="split-pot-count"> · {current.index + 1} of {total}</span>}
          </div>
        )}
        <div className="split-pot-title">
          {ann.split && <SplitIcon />}
          <span>{ann.title}</span>
        </div>
        <div className="split-pot-sub" data-testid="split-pot-sub">
          {ann.subline}
        </div>
        {ann.handLine && <div className="split-pot-hand">{ann.handLine}</div>}
      </div>
      {piles.map((p) => (
        <ChipPile key={p.id} pile={p} from={potPosition} slideMs={reduceMotion ? 0 : TIMINGS.splitSlideMs * (slow ? TIMINGS.slowFactor : 1)} still={reduceMotion} />
      ))}
      {floats.map((f) => {
        const pos = positions.find((p) => p.seatId === f.seatId);
        if (!pos) return null;
        return (
          <div
            key={f.id}
            className={`split-pot-float${reduceMotion ? ' split-pot-float--still' : ''}`}
            data-testid={`split-float-${String(f.seatId)}`}
            style={{ left: `${String(pos.left)}%`, top: `${String(pos.top)}%`, animationDelay: `${String(Math.round(reduceMotion ? 0 : f.delayMs))}ms` }}
          >
            +{formatChips(f.amount)}
          </div>
        );
      })}
    </>
  );
}

/** A pot dividing into arrows: one stack, two arrows parting. */
function SplitIcon(): React.JSX.Element {
  return (
    <svg className="split-pot-icon" viewBox="0 0 32 32" aria-hidden="true">
      <ellipse cx="16" cy="25" rx="6.5" ry="2.4" fill="#f2bd4d" />
      <rect x="9.5" y="19" width="13" height="6" fill="#f2bd4d" />
      <ellipse cx="16" cy="19" rx="6.5" ry="2.4" fill="#ffe08a" />
      <path d="M16 15 V10 M16 10 L8 4 M16 10 L24 4" stroke="#3fe0c5" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M6 7.5 L7.5 3 L11.5 4.6 M26 7.5 L24.5 3 L20.5 4.6" stroke="#3fe0c5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** One winner's pile on the 2D table: out of the pot, spread apart from the others, then off to its winner. */
function ChipPile({ pile, from, slideMs, still }: { pile: Pile; from: { left: number; top: number }; slideMs: number; still: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent || still) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    const dx = ((pile.toLeft - from.left) / 100) * w;
    const dy = ((pile.toTop - from.top) / 100) * h;
    const total = pile.delayMs + slideMs;
    const anim = el.animate(
      [
        { transform: 'translate(-50%, -50%)', opacity: 1, offset: 0 },
        { transform: `translate(calc(-50% + ${String(pile.spread)}px), -50%)`, opacity: 1, offset: total > 0 ? Math.min(0.99, (pile.delayMs * 0.7) / total) : 0 },
        { transform: `translate(calc(-50% + ${String(pile.spread)}px), -50%)`, opacity: 1, offset: total > 0 ? Math.min(0.995, pile.delayMs / total) : 0 },
        { transform: `translate(calc(-50% + ${String(dx)}px), calc(-50% + ${String(dy)}px))`, opacity: 0.2, offset: 1 },
      ],
      { duration: Math.max(1, total), easing: 'ease-in-out', fill: 'forwards' },
    );
    return () => anim.cancel();
  }, [pile, from.left, from.top, slideMs, still]);
  if (still) return <></>;
  return (
    <div ref={ref} className="split-pot-pile" style={{ left: `${String(from.left)}%`, top: `${String(from.top)}%` }}>
      <ChipStack amount={pile.amount} size="md" showAmount={false} />
    </div>
  );
}

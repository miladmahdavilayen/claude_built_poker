import type { ProjectedGameEvent, ProjectedTableState } from '@pokerclause/shared';
import { useEffect, useRef, useState } from 'react';
import type { Card } from '@pokerclause/engine';
import { isBluffHand } from './handStrength.js';
import { rankHand, winningWords, type RankedHand } from './handWords.js';

// The house dealer's voice: the calls a live dealer makes out loud as the
// hand goes on — the action, never who did it; only the result names
// names. Spoken by the
// browser's own speech engine (free, offline, built into every phone), in
// a female or a male voice of the viewer's choosing, or off.
//
// What gets called, as in a cardroom:
// - every action, in a word: "Check", "Call", "Bet", "Raise", "Fold" — and
//   "All in" whenever one is. In no-limit the dealer doesn't state raise
//   amounts unless asked; the amounts are on the table for all to see.
// - "Heads up" when a fold leaves exactly two players in the pot.
// - "Option" to the big blind when the betting comes back unraised.
// - how many see the flop ("Four players to the flop"), then the board as
//   it's dealt: "Flop", "Turn", "River".
// - "Showdown", then who won: "Alex wins with a flush" ("Alex wins", when
//   everyone else folded); a chop between two, both names; three or more
//   ways, just "The pot is split".
// - a winner who chooses to show after everyone folded: "Alex shows the
//   hand", or "Alex shows the bluff" — as their button said.

export type DealerVoiceChoice = 'off' | 'female' | 'male';

const KEY = 'pokerclause.dealerVoice';

/** The voice this viewer picked (female, unless they chose male) — remembered per browser. */
export function loadDealerVoice(): 'female' | 'male' {
  try {
    return window.localStorage.getItem(KEY) === 'male' ? 'male' : 'female';
  } catch {
    return 'female';
  }
}

/**
 * The dealer's voice at a table: always on when the table opens — in the
 * voice the viewer picked last time — and muted only for as long as they
 * keep it so (the corner button, or Off in the menu) while they're there.
 */
export function useDealerVoiceChoice(): { choice: DealerVoiceChoice; choose: (v: DealerVoiceChoice) => void; toggleMute: () => void } {
  const [voice, setVoice] = useState<'female' | 'male'>(loadDealerVoice);
  const [muted, setMuted] = useState(false);
  const choose = (v: DealerVoiceChoice): void => {
    if (v === 'off') {
      setMuted(true);
      if (speechSupported()) window.speechSynthesis.cancel();
      return;
    }
    setVoice(v);
    setMuted(false);
    try {
      window.localStorage.setItem(KEY, v);
    } catch {
      // Storage blocked — it just won't be remembered.
    }
    // A choice made by a tap: say something, so they hear it.
    speak('Good luck, everyone.', v, true);
  };
  return { choice: muted ? 'off' : voice, choose, toggleMute: () => choose(muted ? voice : 'off') };
}

export const speechSupported = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

// The voices each platform ships, best first: Apple's (iPhone, iPad, Mac), Google's (Android, Chrome), Microsoft's (Windows, Edge).
const FEMALE = ['Samantha', 'Ava', 'Allison', 'Susan', 'Karen', 'Serena', 'Kate', 'Moira', 'Tessa', 'Fiona', 'Victoria', 'Google US English', 'Google UK English Female', 'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Zira', 'female'];
const MALE = ['Daniel', 'Alex', 'Tom', 'Aaron', 'Oliver', 'Arthur', 'Fred', 'Rishi', 'Google UK English Male', 'Microsoft Guy', 'Microsoft Ryan', 'Microsoft David', 'Microsoft Mark', 'male'];

function pickVoice(choice: 'female' | 'male'): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
  if (voices.length === 0) return null;
  const wanted = choice === 'female' ? FEMALE : MALE;
  const other = choice === 'female' ? MALE : FEMALE;
  const score = (v: SpeechSynthesisVoice): number => {
    const name = v.name.toLowerCase();
    const i = wanted.findIndex((w) => name.includes(w.toLowerCase()));
    if (i < 0) return -1;
    // The better-sounding downloads first, then US/UK English, then the list's order.
    return 1000 - i * 10 + (/(premium|enhanced|natural|neural)/.test(name) ? 500 : 0) + (/en[-_](us|gb)/i.test(v.lang) ? 5 : 0);
  };
  const best = [...voices].sort((a, b) => score(b) - score(a))[0]!;
  if (score(best) >= 0) return best;
  // No known name: anything not known to be the other kind.
  return voices.find((v) => !other.some((o) => v.name.toLowerCase().includes(o.toLowerCase()))) ?? voices[0]!;
}

/** Says one line. A dealer never falls behind the game: lines still waiting when a new one comes are dropped (`now` clears even the one being spoken). */
export function speak(text: string, choice: DealerVoiceChoice, now = false): void {
  if (choice === 'off' || !speechSupported()) return;
  const synth = window.speechSynthesis;
  if (now || synth.pending) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(choice);
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? 'en-US';
  u.rate = 1.05;
  u.pitch = choice === 'female' ? 1.05 : 0.95;
  synth.speak(u);
}

/** How the winning hand is said after "wins with". */
const HAND_CALLS: Record<string, string> = {
  'high card': 'high card',
  'one pair': 'a pair',
  'two pairs': 'two pair',
  'three of a kind': 'three of a kind',
  straight: 'a straight',
  flush: 'a flush',
  'full house': 'a full house',
  'four of a kind': 'four of a kind',
  'straight flush': 'a straight flush',
};

function winningHand(handName: string | undefined, bestFive: readonly string[] | undefined): string | null {
  if (!handName) return null;
  const royal = handName === 'straight flush' && !!bestFive?.some((c) => c.startsWith('A')) && !!bestFive.some((c) => c.startsWith('K'));
  return royal ? 'a royal flush' : (HAND_CALLS[handName] ?? null);
}

const COUNT = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

/** What the dealer keeps track of through a hand, across event batches. */
export interface HandTrack {
  /** Who's still in the pot. */
  inHand: Set<number>;
  /** "Heads up" has been called this hand. */
  headsUp: boolean;
  /** Who won the main pot (a side pot's winner gets a word only if it's someone else). */
  mainWinners: Set<number>;
  /** The pot's been given out: cards shown now are a winner choosing to show, not a showdown. */
  over: boolean;
  /** The board so far. */
  board: Card[];
  /** The cards shown at the showdown, by seat — to say exactly how the pot was won. */
  shown: Map<number, readonly Card[]>;
}

export const newHandTrack = (): HandTrack => ({ inHand: new Set(), headsUp: false, mainWinners: new Set(), over: false, board: [], shown: new Map() });

/**
 * What the dealer says for a batch of events, in order. The action is
 * never anyone's name — only the result is: who won the pot (and with
 * what), the two players of a chop, or just that the pot is split three or
 * more ways.
 */
export function dealerCalls(events: readonly ProjectedGameEvent[], hand: HandTrack, nameOf: (seatId: number) => string): string[] {
  const out: string[] = [];
  let showdown = false;
  for (const e of events) {
    switch (e.type) {
      case 'hand-started':
        hand.inHand.clear();
        hand.headsUp = false;
        hand.mainWinners.clear();
        hand.over = false;
        hand.board = [];
        hand.shown.clear();
        break;
      case 'cards-dealt':
        for (const s of e.seats) hand.inHand.add(s);
        break;
      case 'action-taken': {
        const allIn = e.action.type !== 'fold' && e.action.type !== 'check' && e.resultingStack === 0;
        const word = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' }[e.action.type];
        if (!word) break;
        out.push(allIn ? (e.action.type === 'call' ? 'Call, all in' : 'All in') : word);
        if (e.action.type === 'fold') {
          const before = hand.inHand.size;
          hand.inHand.delete(e.seatId);
          if (before > 2 && hand.inHand.size === 2) {
            out.push('Heads up');
            hand.headsUp = true;
          }
        }
        break;
      }
      case 'street-dealt':
        hand.board = [...e.board];
        if (e.street === 'flop') {
          // How many see it: "Four players to the flop" — or, two, heads up (unless that's just been called).
          const n = hand.inHand.size;
          if (n > 2) out.push(`${COUNT[n] ?? String(n)} players to the flop`);
          else if (n === 2 && !hand.headsUp) out.push('Heads up to the flop');
          if (n === 2) hand.headsUp = true;
          out.push('Flop');
        } else if (e.street === 'turn' || e.street === 'river') {
          out.push(e.street[0]!.toUpperCase() + e.street.slice(1));
        }
        break;
      case 'showdown-reveal':
        // After the pot's gone, it's the winner choosing to show (Reveal Hand / Show Bluff) — said as the
        // button they tapped says it. Before, it's a showdown.
        if (hand.over) {
          out.push(isBluffHand(e.holeCards, hand.board) ? `${nameOf(e.seatId)} shows the bluff` : `${nameOf(e.seatId)} shows the hand`);
          break;
        }
        hand.shown.set(e.seatId, e.holeCards);
        if (!showdown) out.push('Showdown');
        showdown = true;
        break;
      case 'hand-complete':
        hand.over = true;
        break;
      case 'pot-awarded': {
        hand.over = true;
        const ids = e.winners.map((w) => w.seatId);
        // Each winner's hand from their shown cards and the board, against the hands it beat — so the call
        // says exactly how: "two pair, kings and sevens, ace kicker", not just "two pair".
        const ranked = (seatId: number): RankedHand | null => {
          const hole = hand.shown.get(seatId);
          return hole ? rankHand([...hole, ...hand.board]) : null;
        };
        const beaten = [...hand.shown.keys()]
          .filter((id) => !ids.includes(id))
          .map(ranked)
          .filter((h): h is RankedHand => h !== null);
        const how = (seatId: number, fallback: { handName?: string; bestFive?: readonly Card[] }): string | null => {
          const mine = ranked(seatId);
          return mine ? winningWords(mine, beaten) : winningHand(fallback.handName, fallback.bestFive);
        };
        if (e.potIndex === 0) {
          for (const id of ids) hand.mainWinners.add(id);
          if (ids.length === 1) {
            const w = e.winners[0]!;
            const words = how(w.seatId, w);
            out.push(words ? `${nameOf(w.seatId)} wins with ${words}` : `${nameOf(w.seatId)} wins`);
          } else if (ids.length === 2) {
            const mine = ranked(ids[0]!);
            out.push(`${nameOf(ids[0]!)} and ${nameOf(ids[1]!)} split the pot${mine ? `, both with ${winningWords(mine, [])}` : ''}`);
          } else {
            out.push('The pot is split');
          }
        } else if (ids.length === 1 && !hand.mainWinners.has(ids[0]!)) {
          const words = how(ids[0]!, e.winners[0]!);
          out.push(`${nameOf(ids[0]!)} takes the side pot${words ? ` with ${words}` : ''}`);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The big blind's option: their turn before the flop, nobody having raised (`bigBlindSeat` from the hand's start). */
export function hasBigBlindOption(state: ProjectedTableState | null, bigBlindSeat: number | null): boolean {
  if (!state || bigBlindSeat === null || state.phase !== 'in-hand' || state.street !== 'preflop') return false;
  if (state.betting.actingSeat !== bigBlindSeat || state.betting.currentBet !== state.settings.bigBlind) return false;
  return state.seats.find((s) => s.seatId === bigBlindSeat)?.committedThisStreet === state.settings.bigBlind;
}

/**
 * Speaks the dealer's calls as the game's events arrive, and "Option" when
 * the big blind's turn comes round with nobody having raised.
 */
export function useDealerAnnouncements(events: readonly ProjectedGameEvent[], choice: DealerVoiceChoice, state: ProjectedTableState | null): void {
  const seen = useRef<readonly ProjectedGameEvent[] | null>(null);
  const hand = useRef(newHandTrack());
  // Names as the table shows them, at the moment the line is said.
  const stateRef = useRef(state);
  stateRef.current = state;
  const [bigBlindSeat, setBigBlindSeat] = useState<number | null>(null);
  useEffect(() => {
    for (const e of events) if (e.type === 'hand-started') setBigBlindSeat(e.bigBlindSeat);
  }, [events]);
  const bigBlindOption = hasBigBlindOption(state, bigBlindSeat);
  useEffect(() => {
    if (events === seen.current) return;
    // The batch already there on arrival is history: the dealer starts with what happens next.
    const first = seen.current === null;
    seen.current = events;
    if (first) return;
    const nameOf = (seatId: number): string => stateRef.current?.seats.find((x) => x.seatId === seatId)?.displayName ?? `Seat ${String(seatId + 1)}`;
    const calls = dealerCalls(events, hand.current, nameOf);
    if (choice === 'off' || calls.length === 0) return;
    speak(calls.join('. '), choice);
  }, [events, choice]);
  useEffect(() => {
    if (bigBlindOption) speak('Option', choice);
  }, [bigBlindOption, choice]);
}

/**
 * Phones only let a page speak once the viewer has touched it: the first
 * real tap (the end of a touch, a click — a phone doesn't count the start
 * of one) or key press says nothing (an empty line), which is enough to
 * unlock the voice for the rest of the visit. Returns the cleanup.
 */
export function unlockSpeechOnFirstTap(): () => void {
  if (!speechSupported()) return () => undefined;
  const events = ['touchend', 'click', 'keydown'] as const;
  const unlock = (): void => {
    for (const e of events) window.removeEventListener(e, unlock, true);
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  };
  for (const e of events) window.addEventListener(e, unlock, true);
  return () => {
    for (const e of events) window.removeEventListener(e, unlock, true);
  };
}

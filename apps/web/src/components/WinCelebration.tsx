import type { ProjectedGameEvent } from '@pokerclause/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatChips } from '../chips.js';
import type { SeatPosition } from '../seatLayout.js';
import { playSoftLossTone, playTrophyFanfare, playWinChimeSound, playWinFanfare } from '../sound.js';
import { winTierOf, type WinTier } from '../winTiers.js';
import { TROPHY_CELEBRATION_MS, TrophyCelebration } from './TrophyCelebration.js';

const OTHER_WIN_BADGE_MS = 2200;
const VIEWER_WIN_BANNER_MS = 2400;
const VIEWER_LOSS_BADGE_MS = 1800;

interface OtherWinBadge {
  id: string;
  seatId: number;
  amount: number;
}

/**
 * Lightweight, purely decorative "who won this hand" announcement, driven
 * by events already broadcast for other reasons ('cards-dealt' — to know
 * whether the viewer was even dealt into this hand — and 'pot-awarded' at
 * showdown/fold-win). Deliberately asymmetric: someone else winning gets
 * a small badge by their seat and a quiet chime; the viewer's OWN win
 * gets a bigger banner and a triumphant little fanfare; the viewer
 * losing a hand they were actually dealt into gets a brief, subtle,
 * quiet acknowledgment — never a badge blaring "you won" for someone
 * else, and never a big fanfare for anyone but the viewer. The viewer's
 * win with a straight or better goes further still: a trophy show and
 * fanfare that grow with the hand (see TrophyCelebration.tsx). See
 * DECISIONS.md.
 */
export function WinCelebration({
  events,
  positions,
  viewerSeatId,
}: {
  events: readonly ProjectedGameEvent[];
  positions: readonly SeatPosition[];
  viewerSeatId: number | null;
}): React.JSX.Element | null {
  const [otherBadges, setOtherBadges] = useState<OtherWinBadge[]>([]);
  const [viewerWin, setViewerWin] = useState<{ amount: number; tier: WinTier; key: number } | null>(null);
  const [viewerLost, setViewerLost] = useState(false);
  const viewerInHandRef = useRef(false);
  const badgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const winTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lossTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const badgeBatchRef = useRef(0);
  const winBatchRef = useRef(0);
  const lossBatchRef = useRef(0);
  const lastEventsRef = useRef<readonly ProjectedGameEvent[] | null>(null);

  const showViewerWin = useCallback((amount: number, tier: WinTier): void => {
    const batchId = ++winBatchRef.current;
    if (tier !== 0) playTrophyFanfare(tier);
    else playWinFanfare();
    setViewerWin({ amount, tier, key: batchId });
    if (winTimeoutRef.current) clearTimeout(winTimeoutRef.current);
    winTimeoutRef.current = setTimeout(
      () => {
        if (winBatchRef.current === batchId) setViewerWin(null);
      },
      tier !== 0 ? TROPHY_CELEBRATION_MS[tier] : VIEWER_WIN_BANNER_MS,
    );
  }, []);

  // Dev only: `__celebrate(6)` in the console plays a tier's show at a real
  // table, seats and all (tiers: 1 straight … 6 royal flush, 0 a plain win).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __celebrate?: (tier: WinTier) => void };
    w.__celebrate = (tier) => showViewerWin(4200, tier);
    return () => {
      delete w.__celebrate;
    };
  }, [showViewerWin]);

  useEffect(() => {
    // Celebrate each events batch once — a later viewerSeatId change on its
    // own (e.g. the owner removing this player, who becomes a spectator)
    // must not replay the last hand's win/loss banners.
    if (events === lastEventsRef.current) return;
    lastEventsRef.current = events;
    for (const e of events) {
      if (e.type === 'hand-started') viewerInHandRef.current = false;
      if (e.type === 'cards-dealt' && viewerSeatId !== null && e.seats.includes(viewerSeatId)) viewerInHandRef.current = true;
    }

    const potAwarded = events.filter((e): e is Extract<ProjectedGameEvent, { type: 'pot-awarded' }> => e.type === 'pot-awarded');
    if (potAwarded.length === 0) return;

    // A hand with side pots can award several seats, and the same seat
    // can win more than one pot — combine into one total per seat so a
    // winner gets one badge/banner, not one per pot.
    const totals = new Map<number, number>();
    // The best hand each seat won a pot with — the trophy show's size.
    const tiers = new Map<number, WinTier>();
    for (const pot of potAwarded) {
      for (const w of pot.winners) {
        totals.set(w.seatId, (totals.get(w.seatId) ?? 0) + w.amount);
        tiers.set(w.seatId, Math.max(tiers.get(w.seatId) ?? 0, winTierOf(w.handName, w.bestFive)) as WinTier);
      }
    }

    let viewerWon = false;
    const others: OtherWinBadge[] = [];
    for (const [seatId, amount] of totals) {
      if (seatId === viewerSeatId) {
        viewerWon = true;
        showViewerWin(amount, tiers.get(seatId) ?? 0);
      } else {
        others.push({ id: `${String(seatId)}-${String(amount)}`, seatId, amount });
      }
    }

    if (others.length > 0) {
      const batchId = ++badgeBatchRef.current;
      playWinChimeSound();
      setOtherBadges(others);
      if (badgeTimeoutRef.current) clearTimeout(badgeTimeoutRef.current);
      badgeTimeoutRef.current = setTimeout(() => {
        if (badgeBatchRef.current === batchId) setOtherBadges([]);
      }, OTHER_WIN_BADGE_MS);
    }

    if (!viewerWon && viewerInHandRef.current && viewerSeatId !== null) {
      const batchId = ++lossBatchRef.current;
      playSoftLossTone();
      setViewerLost(true);
      if (lossTimeoutRef.current) clearTimeout(lossTimeoutRef.current);
      lossTimeoutRef.current = setTimeout(() => {
        if (lossBatchRef.current === batchId) setViewerLost(false);
      }, VIEWER_LOSS_BADGE_MS);
    }
  }, [events, viewerSeatId, showViewerWin]);

  useEffect(
    () => () => {
      if (badgeTimeoutRef.current) clearTimeout(badgeTimeoutRef.current);
      if (winTimeoutRef.current) clearTimeout(winTimeoutRef.current);
      if (lossTimeoutRef.current) clearTimeout(lossTimeoutRef.current);
    },
    [],
  );

  const viewerPos = viewerSeatId !== null ? positions.find((p) => p.seatId === viewerSeatId) : undefined;

  return (
    <>
      {otherBadges.map((b) => {
        const pos = positions.find((p) => p.seatId === b.seatId);
        if (!pos) return null;
        return (
          <div key={b.id} className="win-badge" style={{ left: `${String(pos.left)}%`, top: `${String(pos.top)}%` }}>
            +{formatChips(b.amount)}
          </div>
        );
      })}
      {viewerWin !== null && viewerWin.tier !== 0 && (
        <TrophyCelebration key={viewerWin.key} tier={viewerWin.tier} amount={viewerWin.amount} />
      )}
      {viewerWin !== null && viewerWin.tier === 0 && (
        <div className="viewer-win-banner">
          <div className="viewer-win-text">You Win!</div>
          <div className="viewer-win-amount">+{formatChips(viewerWin.amount)}</div>
        </div>
      )}
      {viewerLost && viewerPos && (
        <div className="viewer-loss-badge" style={{ left: `${String(viewerPos.left)}%`, top: `${String(viewerPos.top)}%` }}>
          Not this hand
        </div>
      )}
    </>
  );
}

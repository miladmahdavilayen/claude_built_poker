import type { ProjectedGameEvent } from '@pokerclause/shared';
import { useEffect, useRef, useState } from 'react';
import { formatChips } from '../chips.js';
import type { SeatPosition } from '../seatLayout.js';
import { playSoftLossTone, playWinChimeSound, playWinFanfare } from '../sound.js';

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
 * else, and never a big fanfare for anyone but the viewer. See
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
  const [viewerWinAmount, setViewerWinAmount] = useState<number | null>(null);
  const [viewerLost, setViewerLost] = useState(false);
  const viewerInHandRef = useRef(false);
  const badgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const winTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lossTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const badgeBatchRef = useRef(0);
  const winBatchRef = useRef(0);
  const lossBatchRef = useRef(0);

  useEffect(() => {
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
    for (const pot of potAwarded) {
      for (const w of pot.winners) totals.set(w.seatId, (totals.get(w.seatId) ?? 0) + w.amount);
    }

    let viewerWon = false;
    const others: OtherWinBadge[] = [];
    for (const [seatId, amount] of totals) {
      if (seatId === viewerSeatId) {
        viewerWon = true;
        const batchId = ++winBatchRef.current;
        playWinFanfare();
        setViewerWinAmount(amount);
        if (winTimeoutRef.current) clearTimeout(winTimeoutRef.current);
        winTimeoutRef.current = setTimeout(() => {
          if (winBatchRef.current === batchId) setViewerWinAmount(null);
        }, VIEWER_WIN_BANNER_MS);
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
  }, [events, viewerSeatId]);

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
      {viewerWinAmount !== null && (
        <div className="viewer-win-banner">
          <div className="viewer-win-text">You Win!</div>
          <div className="viewer-win-amount">+{formatChips(viewerWinAmount)}</div>
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

import type { ProjectedSeat } from '@pokerclause/shared';
import { useEffect, useRef, useState } from 'react';
import { TIMINGS } from '../animationTimings.js';
import { avatarHue } from '../avatarColor.js';
import { formatChips } from '../chips.js';
import { PlayingCard } from './PlayingCard.js';
import { StreamMedia } from './StreamMedia.js';

function describeAction(action: { type: string; amountTo?: number } | null): string | null {
  if (!action) return null;
  switch (action.type) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return 'Call';
    case 'bet':
      return `Bet ${action.amountTo !== undefined ? formatChips(action.amountTo) : ''}`;
    case 'raise':
      return `Raise to ${action.amountTo !== undefined ? formatChips(action.amountTo) : ''}`;
    default:
      return action.type;
  }
}

/**
 * A number that, while `active`, counts up smoothly to each new value
 * instead of jumping — a split pot's winner watching their stack grow as
 * their chips land. Anything else (and any decrease) just shows the value.
 */
function useCountUp(value: number, active: boolean): number {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (!active || value <= from) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - start) / TIMINGS.stackCountUpMs);
      const v = Math.round(from + (value - from) * (1 - (1 - t) ** 3));
      shownRef.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, active]);
  return shown;
}

export interface SeatVoiceStream {
  stream: MediaStream;
  isLocal: boolean;
  /** Whose it is (their user id) — for the viewer's own mutes (see callAudio.ts). */
  userId?: string | null;
}

export function Seat({
  seat,
  isButton,
  isActing,
  isViewer,
  positionLabel,
  showCards,
  justRevealed = false,
  voice,
  showVideo = true,
  onEmptySeatClick,
  onAddBotClick,
  onRemoveBotClick,
  onAssignHumanClick,
  splitEffect = null,
  winningCards,
  stackDisplay,
  hideOwnCards = false,
  compact = false,
  ownMark,
  emptyTap,
  callControls,
  peerMute,
}: {
  seat: ProjectedSeat;
  isButton: boolean;
  isActing: boolean;
  isViewer: boolean;
  positionLabel?: string | undefined;
  /** False before this table's very first hand has ever been dealt — an occupied seat shouldn't show placeholder card-backs for a hand that hasn't started. */
  showCards: boolean;
  /** True for a brief window right after this seat voluntarily reveals its hand (see useJustRevealedSeats.ts) — plays a flip animation instead of the cards just silently appearing. */
  justRevealed?: boolean;
  voice?: SeatVoiceStream | null | undefined;
  /** False when the table-wide camera speaker-bar has collapsed every seat's video (see Table.tsx's `speakerBarActive`) — audio keeps playing via StreamMedia's own fallback, only the video box is suppressed. */
  showVideo?: boolean;
  /** Owner-only — self-serve seating no longer exists (see DECISIONS.md); this lets the owner seat THEMSELVES directly. */
  onEmptySeatClick?: (() => void) | undefined;
  /** Owner-only. */
  onAddBotClick?: (() => void) | undefined;
  /** Owner-only. */
  onRemoveBotClick?: (() => void) | undefined;
  /** Owner-only — generates a one-time invite link for a human to redeem into this exact seat. */
  onAssignHumanClick?: (() => void) | undefined;
  /** While a split pot is announced: this pot's winners glow, everyone else in the hand dims (see SplitPotAnnouncement.tsx). */
  splitEffect?: 'winner' | 'dim' | null | undefined;
  /** A split pot's winning cards, raised. */
  winningCards?: ReadonlySet<string> | undefined;
  /** The stack to show instead of `seat.stack` while a split pot's chips are still on their way — it counts up as they land. */
  stackDisplay?: number | undefined;
  /** The viewer's own cards are shown elsewhere (on the 3D table's felt), not in their box. */
  hideOwnCards?: boolean;
  /**
   * The 3D table's box: only what a player needs mid-hand — who it is and
   * their stack, big; on camera, their face with the stack over it. Cards
   * lie on the felt, the button is a puck there, actions are in the ticker,
   * and the owner's controls are on a double tap.
   */
  compact?: boolean;
  /** 3D, your own box: the button or blind you have this hand, shown big on top of it — just below your cards. */
  ownMark?: 'D' | 'SB' | 'BB' | undefined;
  /**
   * An empty seat is one big tap target: the table opens its options (sit
   * here, a computer player, an invite) in a large menu — or, when sitting
   * down is the only thing this viewer can do there, goes straight to it.
   * `label` is what the seat says ("Sit here", or "Tap to fill").
   */
  emptyTap?: { label: string; onTap: (x: number, y: number) => void } | undefined;
  /** Your own box: the call's buttons (mic, camera, leave), on its top edge — see SeatCallControls.tsx. */
  callControls?: React.ReactNode;
  /** Someone else's box, while you can hear them: the button muting them for you — see CallAudioButtons.tsx. */
  peerMute?: React.ReactNode;
}): React.JSX.Element {
  const shownStack = useCountUp(stackDisplay ?? seat.stack, stackDisplay !== undefined);
  // `status === 'empty'` is the authoritative "is this seat occupied?"
  // signal from the engine. `playerId` is NOT a reliable proxy for that —
  // a computer player is a genuinely occupied, active seat that always
  // has `playerId: null` (bots are never real users; see DECISIONS.md).
  // An earlier version of this check used `|| seat.playerId === null`,
  // which meant every bot seat rendered as permanently empty regardless
  // of its real status.
  if (seat.status === 'empty' && emptyTap) {
    return (
      <div className="seat seat-empty">
        <button
          type="button"
          className="seat-empty-tap"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            emptyTap.onTap(e.clientX || r.left + r.width / 2, e.clientY || r.top + r.height / 2);
          }}
        >
          <span className="seat-empty-tap-seat">Seat {seat.seatId + 1}</span>
          <span className="seat-empty-tap-label">{emptyTap.label}</span>
        </button>
      </div>
    );
  }
  if (seat.status === 'empty') {
    return (
      <div className="seat seat-empty">
        {onEmptySeatClick && (
          <span className="seat-empty-action" onClick={onEmptySeatClick} role="button">
            Sit here
          </span>
        )}
        {onAddBotClick && (
          <span className="seat-empty-action seat-empty-action-bot" onClick={onAddBotClick} role="button">
            + Add bot
          </span>
        )}
        {onAssignHumanClick && (
          <span className="seat-empty-action seat-empty-action-assign" onClick={onAssignHumanClick} role="button">
            + Assign human
          </span>
        )}
        {!onEmptySeatClick && !onAddBotClick && !onAssignHumanClick && <span className="seat-empty-label">Empty</span>}
      </div>
    );
  }

  if (compact) {
    const hasCam = !!voice?.stream.getVideoTracks().length && showVideo;
    return (
      <div
        className={`seat seat--compact${isActing ? ' seat-acting' : ''}${seat.status === 'folded' ? ' seat-folded' : ''}${isViewer ? ' seat-viewer' : ''}${hasCam ? ' seat-has-video' : ''}${splitEffect === 'winner' ? ' seat-split-winner' : splitEffect === 'dim' ? ' seat-split-dim' : ''}`}
      >
        {isViewer && callControls}
        {!isViewer && peerMute && <div className="seat-peer-mute">{peerMute}</div>}
        {voice && hasCam && (
          <div className="seat-video">
            <StreamMedia stream={voice.stream} isLocal={voice.isLocal} peerId={voice.userId} />
          </div>
        )}
        {voice && !hasCam && <StreamMedia stream={voice.stream} isLocal={voice.isLocal} peerId={voice.userId} showVideo={false} />}
        {/* A hand shown down: the cards, big, over their head — what everyone at the table wants to see. */}
        {!isViewer && seat.holeCards.length > 0 && (
          <div className="seat-compact-cards" data-testid="showdown-cards">
            {seat.holeCards.map((c, i) => (
              <PlayingCard key={`${c}-${String(i)}`} card={c} justRevealed={justRevealed} winning={!!winningCards?.has(c)} />
            ))}
          </div>
        )}
        {ownMark && (
          <div className={`seat-own-mark seat-own-mark--${ownMark.toLowerCase()}`} data-testid="own-mark">
            {ownMark}
          </div>
        )}
        <div className="seat-compact-info">
          <div className="seat-compact-name">
            {!seat.isConnected && <span className="disconnected-dot" title="Disconnected" />}
            {seat.displayName ?? 'Player'}
          </div>
          <div className={`seat-stack${stackDisplay !== undefined ? ' seat-stack--counting' : ''}`}>{formatChips(shownStack)}</div>
        </div>
      </div>
    );
  }

  const actionLabel = describeAction(seat.lastAction);
  const hasVideo = !!voice?.stream.getVideoTracks().length;
  const showSeatVideo = hasVideo && showVideo;
  const inVoiceCall = !!voice;
  const holeCards = showCards && !(isViewer && hideOwnCards) ? (
    <>
      <PlayingCard card={seat.holeCards[0] ?? null} faceDown={seat.holeCards.length === 0} justRevealed={justRevealed} winning={!!seat.holeCards[0] && !!winningCards?.has(seat.holeCards[0])} />
      <PlayingCard card={seat.holeCards[1] ?? null} faceDown={seat.holeCards.length === 0} justRevealed={justRevealed} winning={!!seat.holeCards[1] && !!winningCards?.has(seat.holeCards[1])} />
    </>
  ) : null;
  // The video overlay never shows a face-down card-back placeholder for
  // someone else's hidden hand — it'd just be 2 dead rectangles covering
  // part of their face for no real information (everyone already knows a
  // seated player has 2 cards). `holeCards.length > 0` is populated by the
  // server ONLY for the viewer's own seat or a seat genuinely revealed at
  // showdown/an all-in runout (see projection.ts's revealedSeatIds) — never
  // just because a hand is in progress — so this only ever shows real
  // cards, at the moment they actually become real. The non-video
  // `.seat-cards` row below (a seat with no camera on) is untouched.
  const showHoleCardsOnVideo = holeCards !== null && seat.holeCards.length > 0;
  const nameRow = (
    <div className="seat-name">
      <span
        className="seat-avatar"
        style={{ background: `hsl(${String(avatarHue(seat.avatarSeed ?? seat.displayName ?? 'x'))}, 55%, 42%)` }}
      >
        {(seat.displayName ?? '?').slice(0, 1).toUpperCase()}
      </span>
      {!seat.isConnected && <span className="disconnected-dot" title="Disconnected" />}
      {seat.displayName ?? 'Player'}
      {/* Server-redacted to null for every viewer except the owner themselves — see projection.ts's viewerIsAdmin gate — so this simply never renders for anyone else, no client-side role check needed. */}
      {seat.ownerNickname && (
        <span className="seat-owner-nickname" title="Only visible to you">
          ({seat.ownerNickname})
        </span>
      )}
      {seat.isBot && <span className="seat-tag seat-tag-bot" title="Computer player">🤖 bot</span>}
      {inVoiceCall && !showSeatVideo && <span className="seat-voice-badge" title="In voice call">🎤</span>}
      {seat.status === 'sitting-out' && !seat.joiningNextHand && <span className="seat-tag">sitting out</span>}
      {/* Owner changes made mid-hand that land when it ends — see LiveTable.applyHandEndChanges. */}
      {seat.joiningNextHand && <span className="seat-tag seat-tag-pending">next hand</span>}
      {seat.leavingAfterHand && <span className="seat-tag seat-tag-leaving">leaving</span>}
      {seat.movingToSeatId !== null && <span className="seat-tag seat-tag-pending">to seat {seat.movingToSeatId + 1}</span>}
      {seat.missedBigBlind && <span className="seat-tag seat-tag-pending">posts BB</span>}
      {seat.pendingChips > 0 && <span className="seat-tag seat-tag-pending">+{formatChips(seat.pendingChips)}</span>}
      {seat.status === 'all-in' && <span className="seat-tag seat-tag-allin">all-in</span>}
    </div>
  );
  const stackRow = (
    <>
      <div className={`seat-stack${stackDisplay !== undefined ? ' seat-stack--counting' : ''}`}>{formatChips(shownStack)}</div>
      {/* The current-street bet itself renders as chip visuals on the felt, in front of the seat (see Table.tsx's bet-chips-slot) — not duplicated as plain text here. */}
      {seat.isBot && onRemoveBotClick && (
        <button type="button" className="seat-remove-bot" onClick={onRemoveBotClick}>
          Remove
        </button>
      )}
    </>
  );

  return (
    <div
      className={`seat ${isActing ? 'seat-acting' : ''} ${seat.status === 'folded' ? 'seat-folded' : ''} ${isViewer ? 'seat-viewer' : ''} ${showSeatVideo ? 'seat-has-video' : ''}${splitEffect === 'winner' ? ' seat-split-winner' : splitEffect === 'dim' ? ' seat-split-dim' : ''}`}
    >
      {isViewer && callControls}
      {!isViewer && peerMute && <div className="seat-peer-mute">{peerMute}</div>}
      {isButton && <div className={`dealer-button${isViewer ? ' dealer-button--mine' : ''}`}>D</div>}
      {/* The button already gets the "D" disc — a "BTN" text badge on top of it too would be redundant clutter. */}
      {positionLabel && !isButton && <div className="position-label">{positionLabel}</div>}
      {voice && showSeatVideo && (
        <div className="seat-video">
          <StreamMedia stream={voice.stream} isLocal={voice.isLocal} peerId={voice.userId} />
          {/* The video now fills the ENTIRE seat card (not just a small box
              inset within it) — the same frame that was already drawn
              around the whole seat (the viewer's own green outline, or an
              acting seat's pulsing one) IS the camera frame now, instead of
              a separate, smaller, redundant orange border sitting inside
              it with dead space around it. Name/cards/stack render as
              overlays on top instead of taking their own space below. */}
          <div className="seat-video-overlay-top">{nameRow}</div>
          <div className="seat-video-overlay-bottom">
            {showHoleCardsOnVideo && !isViewer && <div className="seat-cards">{holeCards}</div>}
            {stackRow}
          </div>
        </div>
      )}
      {/* The viewer's own cards sit just above their camera box rather than over it, so they can still see their own video. */}
      {showSeatVideo && showHoleCardsOnVideo && isViewer && <div className="seat-cards seat-cards-above-video">{holeCards}</div>}
      {voice && !showSeatVideo && <StreamMedia stream={voice.stream} isLocal={voice.isLocal} peerId={voice.userId} showVideo={false} />}
      {!showSeatVideo && (
        <>
          {holeCards && <div className="seat-cards">{holeCards}</div>}
          <div className="seat-info">
            {nameRow}
            {stackRow}
          </div>
        </>
      )}
      {actionLabel && <div className="seat-action-bubble">{actionLabel}</div>}
    </div>
  );
}

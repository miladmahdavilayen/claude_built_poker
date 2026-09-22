import type { ProjectedSeat } from '@pokerclause/shared';
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

export interface SeatVoiceStream {
  stream: MediaStream;
  isLocal: boolean;
}

export function Seat({
  seat,
  isButton,
  isActing,
  isViewer,
  positionLabel,
  showCards,
  voice,
  showVideo = true,
  onEmptySeatClick,
  onAddBotClick,
  onRemoveBotClick,
  onAssignHumanClick,
  onRebuyClick,
}: {
  seat: ProjectedSeat;
  isButton: boolean;
  isActing: boolean;
  isViewer: boolean;
  positionLabel?: string | undefined;
  /** False before this table's very first hand has ever been dealt — an occupied seat shouldn't show placeholder card-backs for a hand that hasn't started. */
  showCards: boolean;
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
  /** Owner-only — rebuys THIS seat's occupant (a human, not a bot). Self-serve rebuy no longer exists. */
  onRebuyClick?: (() => void) | undefined;
}): React.JSX.Element {
  // `status === 'empty'` is the authoritative "is this seat occupied?"
  // signal from the engine. `playerId` is NOT a reliable proxy for that —
  // a computer player is a genuinely occupied, active seat that always
  // has `playerId: null` (bots are never real users; see DECISIONS.md).
  // An earlier version of this check used `|| seat.playerId === null`,
  // which meant every bot seat rendered as permanently empty regardless
  // of its real status.
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

  const actionLabel = describeAction(seat.lastAction);
  const hasVideo = !!voice?.stream.getVideoTracks().length;
  const showSeatVideo = hasVideo && showVideo;
  const inVoiceCall = !!voice;
  const holeCards = showCards ? (
    <>
      <PlayingCard card={seat.holeCards[0] ?? null} faceDown={seat.holeCards.length === 0} />
      <PlayingCard card={seat.holeCards[1] ?? null} faceDown={seat.holeCards.length === 0} />
    </>
  ) : null;

  return (
    <div className={`seat ${isActing ? 'seat-acting' : ''} ${seat.status === 'folded' ? 'seat-folded' : ''} ${isViewer ? 'seat-viewer' : ''}`}>
      {isButton && <div className="dealer-button">D</div>}
      {/* The button already gets the "D" disc — a "BTN" text badge on top of it too would be redundant clutter. */}
      {positionLabel && !isButton && <div className="position-label">{positionLabel}</div>}
      {voice && showSeatVideo && (
        <div className="seat-video">
          <StreamMedia stream={voice.stream} isLocal={voice.isLocal} />
          {/* Cards render ON the video (a bottom fade keeps them legible over
              whatever's behind them) instead of taking their own row below
              it — a seat with its camera on no longer needs both a full-size
              video box AND a full-size card row stacked vertically, which is
              what was making video-enabled seats tall enough to crowd the
              board/other seats on smaller screens. See .seat-video-cards. */}
          {holeCards && (
            <div className="seat-video-cards">
              <div className="seat-cards">{holeCards}</div>
            </div>
          )}
        </div>
      )}
      {voice && !showSeatVideo && <StreamMedia stream={voice.stream} isLocal={voice.isLocal} showVideo={false} />}
      {!showSeatVideo && holeCards && <div className="seat-cards">{holeCards}</div>}
      <div className="seat-info">
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
          {seat.status === 'sitting-out' && <span className="seat-tag">sitting out</span>}
          {seat.status === 'all-in' && <span className="seat-tag seat-tag-allin">all-in</span>}
        </div>
        <div className="seat-stack">{formatChips(seat.stack)}</div>
        {/* The current-street bet itself renders as chip visuals on the felt, in front of the seat (see Table.tsx's bet-chips-slot) — not duplicated as plain text here. */}
        {seat.isBot && onRemoveBotClick && (
          <button type="button" className="seat-remove-bot" onClick={onRemoveBotClick}>
            Remove
          </button>
        )}
        {!seat.isBot && onRebuyClick && (
          <button type="button" className="seat-remove-bot" onClick={onRebuyClick}>
            Rebuy
          </button>
        )}
      </div>
      {actionLabel && <div className="seat-action-bubble">{actionLabel}</div>}
    </div>
  );
}

import type { ProjectedSeat } from '@pokerclause/shared';
import { avatarHue } from '../avatarColor.js';
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
      return `Bet ${String(action.amountTo ?? '')}`;
    case 'raise':
      return `Raise to ${String(action.amountTo ?? '')}`;
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
  voice,
  onEmptySeatClick,
  onAddBotClick,
  onRemoveBotClick,
}: {
  seat: ProjectedSeat;
  isButton: boolean;
  isActing: boolean;
  isViewer: boolean;
  positionLabel?: string | undefined;
  voice?: SeatVoiceStream | null | undefined;
  onEmptySeatClick?: (() => void) | undefined;
  onAddBotClick?: (() => void) | undefined;
  onRemoveBotClick?: (() => void) | undefined;
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
        {!onEmptySeatClick && !onAddBotClick && <span className="seat-empty-label">Empty</span>}
      </div>
    );
  }

  const actionLabel = describeAction(seat.lastAction);
  const hasVideo = !!voice?.stream.getVideoTracks().length;
  const inVoiceCall = !!voice;

  return (
    <div className={`seat ${isActing ? 'seat-acting' : ''} ${seat.status === 'folded' ? 'seat-folded' : ''} ${isViewer ? 'seat-viewer' : ''}`}>
      {isButton && <div className="dealer-button">D</div>}
      {/* The button already gets the "D" disc — a "BTN" text badge on top of it too would be redundant clutter. */}
      {positionLabel && !isButton && <div className="position-label">{positionLabel}</div>}
      {voice && hasVideo && (
        <div className="seat-video">
          <StreamMedia stream={voice.stream} isLocal={voice.isLocal} />
        </div>
      )}
      {voice && !hasVideo && <StreamMedia stream={voice.stream} isLocal={voice.isLocal} />}
      <div className="seat-cards">
        <PlayingCard card={seat.holeCards[0] ?? null} faceDown={seat.holeCards.length === 0} />
        <PlayingCard card={seat.holeCards[1] ?? null} faceDown={seat.holeCards.length === 0} />
      </div>
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
          {seat.isBot && <span className="seat-tag seat-tag-bot" title="Computer player">🤖 bot</span>}
          {inVoiceCall && !hasVideo && <span className="seat-voice-badge" title="In voice call">🎤</span>}
          {seat.status === 'sitting-out' && <span className="seat-tag">sitting out</span>}
          {seat.status === 'all-in' && <span className="seat-tag seat-tag-allin">all-in</span>}
        </div>
        <div className="seat-stack">{seat.stack.toLocaleString()}</div>
        {/* The current-street bet itself renders as chip visuals on the felt, in front of the seat (see Table.tsx's bet-chips-slot) — not duplicated as plain text here. */}
        {seat.isBot && onRemoveBotClick && (
          <button type="button" className="seat-remove-bot" onClick={onRemoveBotClick}>
            Remove
          </button>
        )}
      </div>
      {actionLabel && <div className="seat-action-bubble">{actionLabel}</div>}
    </div>
  );
}

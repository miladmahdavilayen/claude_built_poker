import { useEffect, useState } from 'react';
import { formatChips } from '../chips.js';
import type { ChangeSeatAck } from '../useTableSocket.js';

/**
 * Moving to an empty seat: first what it means — now, or after the hand
 * you're in; free, or a big blind if the move skips one (the server
 * decides; see LiveTable.seatMoveCost) — then the move itself.
 */
export function SeatMoveModal({
  seatNumber,
  quote,
  onConfirm,
  onClose,
}: {
  /** As players see it (seat id + 1). */
  seatNumber: number;
  quote: () => Promise<ChangeSeatAck>;
  onConfirm: () => Promise<ChangeSeatAck>;
  onClose: () => void;
}): React.JSX.Element {
  const [info, setInfo] = useState<ChangeSeatAck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Asked once, when it opens.
  const [ask] = useState(() => quote);
  useEffect(() => {
    let live = true;
    void ask().then((r) => {
      if (live) setInfo(r);
    });
    return () => {
      live = false;
    };
  }, [ask]);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal seat-move-modal" role="dialog" aria-label={`Move to seat ${String(seatNumber)}`} onClick={(e) => e.stopPropagation()}>
        <h3>Move to seat {seatNumber}?</h3>
        {!info && <p className="muted">Checking the blinds…</p>}
        {info && !info.ok && <p className="error">{info.message}</p>}
        {info?.ok && (
          <>
            <p>{info.when === 'now' ? 'You move right away.' : 'You move as soon as this hand ends — the seat is held for you.'}</p>
            {info.owes > 0 ? (
              <p className="seat-move-cost">
                This seat is further from the big blind, so moving skips it. You post <strong>{formatChips(info.owes)}</strong> (one big
                blind) on your next hand — live, so it counts toward your call.
              </p>
            ) : (
              <p className="muted">No blind to post: the big blind reaches you just as soon from there.</p>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !info?.ok}
            onClick={() => {
              setBusy(true);
              void onConfirm().then((r) => {
                setBusy(false);
                if (r.ok) onClose();
                else setError(r.message);
              });
            }}
          >
            {info?.ok && info.owes > 0 ? `Move & post ${formatChips(info.owes)}` : 'Move'}
          </button>
        </div>
      </div>
    </div>
  );
}

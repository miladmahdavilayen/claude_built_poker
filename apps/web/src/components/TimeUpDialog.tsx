import { useState } from 'react';

/**
 * The owner's choice when a timed table's time is up and it has paused: more time and carry on, carry on with no
 * timer, or end the game — everyone paid out, the table left in the lobby for the owner to delete or reuse.
 */
export function TimeUpDialog({
  onExtend,
  onNoTimer,
  onEndGame,
  onLater,
}: {
  onExtend: (minutes: number) => void;
  onNoTimer: () => void;
  onEndGame: () => void;
  onLater: () => void;
}): React.JSX.Element {
  const [minutes, setMinutes] = useState<number | ''>(30);
  const [confirmEnd, setConfirmEnd] = useState(false);
  return (
    <div className="modal-backdrop">
      <div className="modal time-up-dialog" role="dialog" aria-label="Time is up">
        <h3>⏱ Time&rsquo;s up</h3>
        <p>The table is paused for everyone. Give it more time and play on, or end the game.</p>
        {!confirmEnd ? (
          <>
            <div className="table-timer-buttons">
              {[15, 30, 60].map((m) => (
                <button key={m} type="button" className="btn-primary" onClick={() => onExtend(m)}>
                  +{m} min
                </button>
              ))}
            </div>
            <div className="table-timer-set">
              <label>
                Or this many minutes
                <input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value === '' ? '' : Number(e.target.value))} />
              </label>
              <button type="button" disabled={minutes === '' || minutes < 1 || minutes > 1440} onClick={() => minutes !== '' && onExtend(Math.round(minutes))}>
                Resume
              </button>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={onLater}>
                Decide later
              </button>
              <button type="button" onClick={onNoTimer}>
                Resume with no timer
              </button>
              <button type="button" className="btn-owner-danger" onClick={() => setConfirmEnd(true)}>
                End the game
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="owner-menu-note">Everyone is paid out what they have and goes back to watching. The table stays in your lobby until you delete it.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirmEnd(false)}>
                Back
              </button>
              <button type="button" className="btn-owner-danger" onClick={onEndGame}>
                Yes, end the game
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

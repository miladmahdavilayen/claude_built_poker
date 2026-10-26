import { useEffect, useState } from 'react';
import { orderedDealers, type DealerCharacter } from '../table3d/dealers.js';

/**
 * The owner's choice of house dealer for this table — opened by
 * double-tapping her on the 3D table. Everyone at the table sees the
 * change (it's the table's `houseDealer` setting).
 */
export function DealerPicker({
  characters,
  current,
  onPick,
  onClose,
}: {
  characters: readonly DealerCharacter[];
  /** The table's setting: a character id, or none (the first character deals). */
  current: string | undefined;
  onPick: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  // On a phone, the double tap's own trailing click lands wherever the finger was — on the backdrop or a
  // name, the instant this opens. So for a moment it takes no taps at all.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 450);
    return () => clearTimeout(t);
  }, []);
  const active = characters.some((c) => c.id === current) ? current : orderedDealers(characters)[0]?.id;
  const regular = characters.filter((c) => !c.vip).map((c) => ({ id: c.id, name: c.name }));
  const vip = characters.filter((c) => c.vip).map((c) => ({ id: c.id, name: c.name }));
  const option = (o: { id: string; name: string }, isVip = false): React.JSX.Element => (
    <button
      key={o.id}
      type="button"
      className={`dealer-picker-option${o.id === active ? ' dealer-picker-option--active' : ''}${isVip ? ' dealer-picker-option--vip' : ''}`}
      aria-pressed={o.id === active}
      onClick={() => onPick(o.id)}
    >
      {isVip && <span aria-hidden="true">★ </span>}
      {o.name}
      {o.id === active && <span className="dealer-picker-check"> ✓</span>}
    </button>
  );
  return (
    <div className="modal-backdrop" style={ready ? undefined : { pointerEvents: 'none' }} onClick={onClose}>
      <div className="modal dealer-picker" role="dialog" aria-label="Choose the house dealer" onClick={(e) => e.stopPropagation()}>
        <h3>House dealer</h3>
        <p className="muted">Everyone at this table sees who you pick.</p>
        {vip.length > 0 && (
          <>
            <h4 className="dealer-picker-heading">VIP dealers</h4>
            <div className="dealer-picker-list">{vip.map((o) => option(o, true))}</div>
            <h4 className="dealer-picker-heading">Dealers</h4>
          </>
        )}
        <div className="dealer-picker-list">{regular.map((o) => option(o))}</div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

import type { LegalActions } from '@pokerclause/engine';
import { useEffect, useState } from 'react';
import { formatChips } from '../chips.js';

export function ActionBar({
  legalActions,
  onAction,
  potSize,
  bigBlind,
}: {
  legalActions: LegalActions;
  onAction: (type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amountTo?: number) => void;
  potSize: number;
  bigBlind: number;
}): React.JSX.Element {
  const showsAmount = legalActions.canBet || legalActions.canRaise;
  const min = legalActions.canRaise ? legalActions.minRaiseTo : legalActions.minBet;
  const max = legalActions.canRaise ? legalActions.maxRaiseTo : legalActions.maxBet;
  const [amount, setAmount] = useState(min);

  useEffect(() => {
    setAmount(min);
  }, [legalActions.seatId, min, max]);

  const commit = (type: 'bet' | 'raise'): void => onAction(type, Math.min(Math.max(amount, min), max));

  return (
    <div className="action-bar">
      {showsAmount && (
        <div className="bet-sizer">
          <input
            type="range"
            min={min}
            max={Math.max(max, min)}
            step={bigBlind}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
          <div className="bet-sizer-row">
            <input
              type="number"
              min={min}
              max={max}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
            <button type="button" onClick={() => setAmount(Math.min(Math.max(Math.round(potSize / 2), min), max))}>
              1/2 pot
            </button>
            <button type="button" onClick={() => setAmount(Math.min(Math.max(potSize, min), max))}>
              Pot
            </button>
            <button type="button" onClick={() => setAmount(max)}>
              All-in
            </button>
          </div>
        </div>
      )}
      <div className="action-buttons">
        {legalActions.canFold && (
          <button type="button" className="btn-fold" onClick={() => onAction('fold')}>
            Fold
          </button>
        )}
        {legalActions.canCheck && (
          <button type="button" className="btn-check" onClick={() => onAction('check')}>
            Check
          </button>
        )}
        {legalActions.canCall && (
          <button type="button" className="btn-call" onClick={() => onAction('call')}>
            Call {formatChips(legalActions.callAmount)}
          </button>
        )}
        {legalActions.canBet && (
          <button type="button" className="btn-bet" onClick={() => commit('bet')}>
            Bet
          </button>
        )}
        {legalActions.canRaise && (
          <button type="button" className="btn-bet" onClick={() => commit('raise')}>
            {legalActions.isAllInOnly ? 'All-in' : 'Raise'}
          </button>
        )}
      </div>
    </div>
  );
}

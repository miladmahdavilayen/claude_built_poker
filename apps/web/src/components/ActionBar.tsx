import type { LegalActions } from '@pokerclause/engine';
import { useEffect, useState } from 'react';
import { formatChips } from '../chips.js';
import { useIsCompactScreen } from '../useIsCompactScreen.js';
import { VerticalBetSlider } from './VerticalBetSlider.js';

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
  // Phones/iPhones only — desktop keeps the original horizontal inline
  // slider unchanged (see DECISIONS.md discussion of this component).
  const isCompact = useIsCompactScreen();

  useEffect(() => {
    setAmount(min);
  }, [legalActions.seatId, min, max]);

  const clampedMax = Math.max(max, min);
  const clamp = (v: number): number => Math.min(Math.max(v, min), clampedMax);
  const commit = (type: 'bet' | 'raise'): void => onAction(type, clamp(amount));
  const setHalfPot = (): void => setAmount(clamp(Math.round(potSize / 2)));
  const setPot = (): void => setAmount(clamp(potSize));
  const setAllIn = (): void => setAmount(clampedMax);

  const foldButton = legalActions.canFold && (
    <button type="button" className="btn-fold" onClick={() => onAction('fold')}>
      Fold
    </button>
  );
  const checkButton = legalActions.canCheck && (
    <button type="button" className="btn-check" onClick={() => onAction('check')}>
      Check
    </button>
  );
  const callButton = legalActions.canCall && (
    <button type="button" className="btn-call" onClick={() => onAction('call')}>
      Call {formatChips(legalActions.callAmount)}
    </button>
  );

  if (isCompact && showsAmount) {
    const confirmType = legalActions.canRaise ? 'raise' : 'bet';
    const confirmLabel = legalActions.isAllInOnly
      ? 'All-in'
      : `${legalActions.canRaise ? 'Raise to' : 'Bet'} ${formatChips(clamp(amount))}`;

    return (
      <div className="bet-overlay">
        {/* Fold/Check/Call live in a thin rail hugging the LEFT edge only —
            the center majority of the screen (board cards, the viewer's own
            hole cards, camera windows) has no overlay element over it at
            all, faded or otherwise. See the matching right rail below and
            the .bet-overlay-rail CSS. */}
        <div className="bet-overlay-rail bet-overlay-rail--left">
          {foldButton}
          {checkButton}
          {callButton}
        </div>
        <div className="bet-overlay-rail bet-overlay-rail--right">
          <input
            type="number"
            className="bet-overlay-input"
            min={min}
            max={clampedMax}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
          <div className="bet-overlay-presets">
            <button type="button" onClick={setHalfPot}>
              ½ pot
            </button>
            <button type="button" onClick={setPot}>
              Pot
            </button>
            <button type="button" onClick={setAllIn}>
              All-in
            </button>
          </div>
          {/* $1 precision regardless of the table's big blind — the
              slider's own drag curve (see VerticalBetSlider) is what keeps
              that comfortable to hit by hand, not a coarser step. */}
          <VerticalBetSlider min={min} max={clampedMax} step={1} value={amount} onChange={setAmount} formatValue={formatChips} />
          <div className="vbs-nudge">
            <button type="button" aria-label="Decrease amount by $1" onClick={() => setAmount(clamp(amount - 1))}>
              −
            </button>
            <button type="button" aria-label="Increase amount by $1" onClick={() => setAmount(clamp(amount + 1))}>
              +
            </button>
          </div>
          <button type="button" className="btn-bet bet-overlay-confirm" onClick={() => commit(confirmType)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="action-bar">
      {showsAmount && (
        <div className="bet-sizer">
          <input
            type="range"
            min={min}
            max={clampedMax}
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
            <button type="button" onClick={setHalfPot}>
              1/2 pot
            </button>
            <button type="button" onClick={setPot}>
              Pot
            </button>
            <button type="button" onClick={setAllIn}>
              All-in
            </button>
          </div>
        </div>
      )}
      <div className="action-buttons">
        {foldButton}
        {checkButton}
        {callButton}
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

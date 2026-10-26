import type { LegalActions } from '@pokerclause/engine';
import { useEffect, useState } from 'react';
import { formatChips } from '../chips.js';
import { useIsCompactScreen } from '../useIsCompactScreen.js';
import { MoneyInput } from './MoneyInput.js';
import { VerticalBetSlider } from './VerticalBetSlider.js';

export function ActionBar({
  legalActions,
  onAction,
  potSize,
  bigBlind,
  smallBlind,
}: {
  legalActions: LegalActions;
  onAction: (type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amountTo?: number) => void;
  potSize: number;
  /** Amounts are cents, like everything — see packages/shared/src/money.ts. */
  bigBlind: number;
  smallBlind: number;
}): React.JSX.Element {
  const showsAmount = legalActions.canBet || legalActions.canRaise;
  const min = legalActions.canRaise ? legalActions.minRaiseTo : legalActions.minBet;
  const max = legalActions.canRaise ? legalActions.maxRaiseTo : legalActions.maxBet;
  const [amount, setAmount] = useState(min);
  // Phones/iPhones only — desktop keeps the original horizontal inline
  // slider unchanged (see DECISIONS.md discussion of this component).
  const isCompact = useIsCompactScreen();
  // Phones: the sizer stays folded away (the table stays in view) until Raise
  // is pressed; once an amount is picked — a drag let go, a preset, a nudge —
  // the slider's $ handle itself becomes the button that sends it.
  const [sizing, setSizing] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setAmount(min);
    setSizing(false);
    setArmed(false);
  }, [legalActions.seatId, min, max]);

  const clampedMax = Math.max(max, min);
  // The −/+ nudge moves by the table's small blind: $1 on a $1/$2 table,
  // $0.10 on a $0.10/$0.20 one — fine-grained at any stake.
  const nudge = Math.max(1, smallBlind);
  const clamp = (v: number): number => Math.min(Math.max(v, min), clampedMax);
  const commit = (type: 'bet' | 'raise'): void => onAction(type, clamp(amount));
  const pick = (v: number): void => {
    setAmount(clamp(v));
    setArmed(true);
  };
  const setHalfPot = (): void => pick(Math.round(potSize / 2));
  const setPot = (): void => pick(potSize);
  const setAllIn = (): void => pick(clampedMax);

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
    const verb = legalActions.canRaise ? 'Raise' : 'Bet';

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
        {legalActions.isAllInOnly ? (
          // Nothing to size: all-in is the only raise.
          <div className="bet-overlay-rail bet-overlay-rail--right">
            <button type="button" className="btn-bet bet-overlay-confirm" onClick={() => commit(confirmType)}>
              All-in
            </button>
          </div>
        ) : !sizing ? (
          <div className="bet-overlay-rail bet-overlay-rail--right">
            <button type="button" className="btn-bet bet-overlay-open" onClick={() => setSizing(true)}>
              {verb}
            </button>
          </div>
        ) : (
          <div className="bet-overlay-rail bet-overlay-rail--right bet-overlay-rail--sizing">
            <button type="button" className="bet-overlay-close" aria-label={`Close the ${verb.toLowerCase()} slider`} onClick={() => setSizing(false)}>
              ✕
            </button>
            <MoneyInput
              className="bet-overlay-input"
              minCents={min}
              maxCents={clampedMax}
              cents={amount}
              onChange={(c) => {
                setAmount(c === '' ? min : c);
                setArmed(true);
              }}
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
            {/* Small-blind precision ($1 on a $1/$2 table, $0.10 on a
                $0.10/$0.20 one) regardless of the big blind — the slider's
                own drag curve (see VerticalBetSlider) is what keeps that
                comfortable to hit by hand, not a coarser step. Let go of the
                $ and it turns into the button: tap it to send that amount. */}
            <VerticalBetSlider
              min={min}
              max={clampedMax}
              step={nudge}
              value={amount}
              onChange={setAmount}
              formatValue={formatChips}
              onRelease={() => setArmed(true)}
              submitLabel={armed ? verb : undefined}
              onSubmit={() => commit(confirmType)}
            />
            <div className="vbs-nudge">
              <button type="button" aria-label={`Decrease amount by ${formatChips(nudge)}`} onClick={() => pick(amount - nudge)}>
                −
              </button>
              <button type="button" aria-label={`Increase amount by ${formatChips(nudge)}`} onClick={() => pick(amount + nudge)}>
                +
              </button>
            </div>
          </div>
        )}
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
            <MoneyInput minCents={min} maxCents={max} cents={amount} onChange={(c) => setAmount(c === '' ? min : c)} />
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

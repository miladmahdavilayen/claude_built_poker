import { chipBreakdown, formatChips } from '../chips.js';

export function ChipStack({
  amount,
  size = 'sm',
  showAmount = true,
}: {
  amount: number;
  size?: 'sm' | 'md';
  showAmount?: boolean;
}): React.JSX.Element | null {
  if (amount <= 0) return null;
  const chips = chipBreakdown(amount, size === 'md' ? 4 : 3);
  return (
    <div className={`chip-stack chip-stack-${size}`}>
      <div className="chip-stack-discs">
        {chips.map((c, i) => (
          <span
            key={`${String(c.value)}-${String(i)}`}
            className="chip-disc"
            style={{ background: c.base, borderColor: c.edge, bottom: `${String(i * 3)}px`, zIndex: i }}
          />
        ))}
      </div>
      {showAmount && <span className="chip-stack-amount">{formatChips(amount)}</span>}
    </div>
  );
}

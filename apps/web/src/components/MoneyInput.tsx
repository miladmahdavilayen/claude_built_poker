import { centsToDollars, dollarsToCents } from '@pokerclause/shared/money';
import { useEffect, useState } from 'react';

/**
 * A dollar amount field that reports integer cents — every amount in the
 * app is cents (see packages/shared/src/money.ts); people type dollars
 * ("0.10", "2.5", "100"). The typed text is kept as-is while editing, so
 * an in-progress "0." or a cleared field isn't rewritten under the cursor;
 * it only re-syncs when the parent's value changes to something the text
 * doesn't already mean (e.g. a modal reopening with a new default).
 */
export function MoneyInput({
  cents,
  onChange,
  minCents,
  maxCents,
  ...rest
}: {
  cents: number | '';
  onChange: (cents: number | '') => void;
  minCents?: number;
  maxCents?: number;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'>): React.JSX.Element {
  // Whole dollars stay plain ("100"); anything with cents always shows two places ("0.40", not "0.4").
  const toText = (c: number | ''): string => (c === '' ? '' : c % 100 === 0 ? String(centsToDollars(c)) : centsToDollars(c).toFixed(2));
  const [text, setText] = useState(() => toText(cents));

  useEffect(() => {
    const textMeans = text.trim() === '' ? '' : dollarsToCents(Number(text));
    if (textMeans !== cents) setText(toText(cents));
    // Deliberately keyed on `cents` only — see the doc comment.
  }, [cents]);

  return (
    <input
      {...rest}
      type="number"
      inputMode="decimal"
      step="0.01"
      min={minCents !== undefined ? centsToDollars(minCents) : undefined}
      max={maxCents !== undefined ? centsToDollars(maxCents) : undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const trimmed = e.target.value.trim();
        const dollars = Number(trimmed);
        onChange(trimmed === '' || !Number.isFinite(dollars) ? '' : dollarsToCents(dollars));
      }}
    />
  );
}

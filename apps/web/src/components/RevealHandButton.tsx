import { useIsCompactScreen } from '../useIsCompactScreen.js';

/**
 * The lone control a human sees between hands after winning a pot nobody
 * else contested to the end — "show the bluff" or just show a real hand
 * for fun (see LiveTable.revealHand and ProjectedTableState.revealEligibleSeatId).
 * Deliberately mirrors ActionBar's own compact-vs-desktop split and reuses
 * its rail's exact sizing on a phone (same size and shape as the fold/
 * check/call buttons it sits above, just a different color) rather than
 * inventing a new layout.
 */
export function RevealHandButton({ label, onReveal }: { label: 'Reveal Hand' | 'Show Bluff'; onReveal: () => void }): React.JSX.Element {
  const isCompact = useIsCompactScreen();
  const button = (
    <button type="button" className="btn-reveal-hand" onClick={onReveal}>
      {label}
    </button>
  );

  if (isCompact) {
    return <div className="reveal-hand-rail">{button}</div>;
  }
  return <div className="reveal-hand-bar">{button}</div>;
}

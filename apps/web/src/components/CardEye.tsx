/**
 * The small eye at the bottom of each of your dealt cards when only two
 * players are left in the hand, or for anyone once the hand is complete: tap
 * it and that card is shown to the table (LiveTable.showCard). Open and lit
 * once it's been shown.
 */
export function CardEye({ index, shown, onShow }: { index: number; shown: boolean; onShow: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`card-eye${shown ? ' card-eye--shown' : ''}`}
      data-testid={`card-eye-${String(index)}`}
      aria-label={shown ? 'This card is shown to the table' : 'Show this card to the table'}
      aria-pressed={shown}
      disabled={shown}
      // Never the seat's or the table's own gestures under it.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onShow();
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z" />
        <circle cx="12" cy="12" r="3" fill={shown ? 'currentColor' : 'none'} />
      </svg>
    </button>
  );
}

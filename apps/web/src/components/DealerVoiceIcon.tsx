/**
 * The dealer's voice, as a picture: a dealer (head, shoulders, a gold bow
 * tie) speaking — sound waves beside them — or, muted, a cross where the
 * waves were. Drawn in the button's own text colour.
 */
export function DealerVoiceIcon({ muted }: { muted: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {/* Head and shoulders. */}
      <circle cx="8.5" cy="7.5" r="3.2" />
      <path d="M2.5 20.5c0-3.6 2.7-6 6-6s6 2.4 6 6" />
      {/* The bow tie. */}
      <path d="M6.4 15.4l2.1 1.2 2.1-1.2v2.6l-2.1-1.2-2.1 1.2z" fill="#f2bd4d" stroke="#f2bd4d" strokeWidth="0.8" />
      {muted ? (
        <path d="M16.5 8.5l5 5M21.5 8.5l-5 5" stroke="#ff8a80" strokeWidth="2" />
      ) : (
        <>
          <path d="M15.5 8.6a3.6 3.6 0 0 1 0 4.8" />
          <path d="M18.2 6.4a7 7 0 0 1 0 9.2" />
        </>
      )}
    </svg>
  );
}

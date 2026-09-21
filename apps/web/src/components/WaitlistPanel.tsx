import type { WaitlistEntry } from '@pokerclause/shared';

export function WaitlistPanel({
  waitlist,
  myUserId,
  canJoin,
  onJoin,
  onLeave,
}: {
  waitlist: readonly WaitlistEntry[];
  myUserId: string;
  /** False for a seated player — they can only see the queue, not join it. */
  canJoin: boolean;
  onJoin: () => void;
  onLeave: () => void;
}): React.JSX.Element | null {
  if (waitlist.length === 0 && !canJoin) return null;

  const myIndex = waitlist.findIndex((w) => w.userId === myUserId);
  const onList = myIndex !== -1;

  return (
    <div className="waitlist-panel">
      <div className="waitlist-header">
        <span>Waitlist{waitlist.length > 0 ? ` (${String(waitlist.length)})` : ''}</span>
        {canJoin &&
          (onList ? (
            <button type="button" onClick={onLeave}>
              Leave waitlist (#{String(myIndex + 1)})
            </button>
          ) : (
            <button type="button" onClick={onJoin}>
              Join waitlist
            </button>
          ))}
      </div>
      {waitlist.length > 0 && (
        <ol className="waitlist-entries">
          {waitlist.map((w) => (
            <li key={w.userId} className={w.userId === myUserId ? 'waitlist-me' : ''}>
              {w.displayName}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

import type { SeatOffer } from '@pokerclause/shared';
import { useEffect, useState } from 'react';

/** "0:42" — time left on a held seat, ticking down. */
function useSecondsLeft(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [expiresAt]);
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * The open-invite waitlist's held seat, said out loud: to its person, that
 * it's theirs and how long they have; to everyone else, who it's for — so a
 * free seat they can't take isn't a mystery.
 */
export function SeatOfferBanner({ offer, myUserId, amSeated }: { offer: SeatOffer; myUserId: string; amSeated: boolean }): React.JSX.Element | null {
  const left = useSecondsLeft(offer.expiresAt);
  const clock = `${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, '0')}`;
  if (offer.userId === myUserId) {
    return (
      <div className="seat-offer-banner seat-offer-mine" role="alert">
        <strong>🔔 A seat is open for you!</strong> Tap any empty seat to sit down — it&rsquo;s held for you for <span className="seat-offer-clock">{clock}</span>.
      </div>
    );
  }
  if (amSeated) return null;
  return (
    <div className="seat-offer-banner" role="status">
      A seat is being held for <strong>{offer.displayName}</strong>, next on the waitlist (<span className="seat-offer-clock">{clock}</span>).
    </div>
  );
}

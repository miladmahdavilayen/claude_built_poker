import { useEffect, useRef } from 'react';
import type { SeatOffer } from '@pokerclause/shared';
import { playSeatOfferAlert } from './sound.js';

/**
 * Alerts this viewer — however they're looking (or not) — the moment an
 * open-invite table holds a seat for them: a chime, a vibration on a phone,
 * a flashing tab title, and a system notification if they allowed them
 * (asked when they joined the waitlist — see requestSeatAlerts). Fires once
 * per offer.
 */
export function useSeatOfferAlert(offer: SeatOffer | null, myUserId: string, tableName: string): void {
  const alerted = useRef<number | null>(null);
  const mine = offer?.userId === myUserId ? offer : null;

  useEffect(() => {
    if (!mine || alerted.current === mine.expiresAt) return;
    alerted.current = mine.expiresAt;
    playSeatOfferAlert();
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try {
        const n = new Notification('A seat is open for you', { body: `${tableName} — take it before it goes to the next person.`, tag: 'pokerclause-seat' });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        // Some mobile browsers only allow notifications from a service worker — the chime and title still do the job.
      }
    }
  }, [mine, tableName]);

  // Flash the tab title until it's taken, missed, or seen.
  useEffect(() => {
    if (!mine) return;
    const original = document.title;
    let on = false;
    const id = setInterval(() => {
      on = !on;
      document.title = on ? '🔔 Your seat is open!' : original;
    }, 900);
    return () => {
      clearInterval(id);
      document.title = original;
    };
  }, [mine]);
}

/** Asks (once, from a click) for permission to show a system notification when a seat opens. */
export function requestSeatAlerts(): void {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
}

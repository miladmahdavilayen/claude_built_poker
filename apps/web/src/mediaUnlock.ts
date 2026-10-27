import { useSyncExternalStore } from 'react';
import { isAudioLocked, onAudioStateChange, unlockAudio } from './sound.js';

/**
 * Browsers refuse to start unmuted playback until the page has had a user
 * gesture (Safari is strictest, and is also why sound used to appear only
 * after "Join voice": that click was the gesture). Someone who never joins
 * the call still has to hear the table, so every remote `<audio>` goes
 * through `playOrQueue`: if the browser blocks it, the element waits here
 * and is retried on the viewer's next tap/click/key anywhere on the page,
 * or straight away from the "Tap to hear the table" button in VoicePanel.
 */
const blocked = new Set<HTMLMediaElement>();
const listeners = new Set<() => void>();
let blockedSnapshot = false;

function notify(): void {
  blockedSnapshot = blocked.size > 0;
  for (const l of listeners) l();
}

export function playOrQueue(el: HTMLMediaElement): void {
  el.play().then(
    () => {
      if (blocked.delete(el)) notify();
    },
    (err: unknown) => {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        blocked.add(el);
        notify();
      }
    },
  );
}

export function forgetMedia(el: HTMLMediaElement): void {
  if (blocked.delete(el)) notify();
}

/** Must run inside a user gesture to help — retries everything the browser refused earlier, the game's own sound included. */
export function unlockMedia(): void {
  unlockAudio();
  for (const el of [...blocked]) {
    if (!el.isConnected) {
      blocked.delete(el);
      continue;
    }
    playOrQueue(el);
  }
  notify();
}

if (typeof document !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'touchend'] as const) {
    document.addEventListener(type, () => blocked.size > 0 && unlockMedia(), { capture: true, passive: true });
  }
}

/** True while some remote audio — or the game's own sound (see sound.ts) — is waiting on a user gesture to start. */
export function useMediaBlocked(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      const off = onAudioStateChange(onChange);
      return () => {
        listeners.delete(onChange);
        off();
      };
    },
    () => blockedSnapshot || isAudioLocked(),
    () => false,
  );
}

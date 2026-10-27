import { useSyncExternalStore } from 'react';

// What this viewer hears of the call: everyone, by default. They can mute
// the whole call (the button in the table's corner, shown while anyone is
// talking) or one person at a time (the speaker button on that player's
// box). Only ever local — it changes what you hear, never what anyone
// sends. Remembered for this tab (a reload keeps it; a new visit starts
// with everyone on).

interface CallAudioState {
  muteAll: boolean;
  /** Players muted one by one (their user ids). Kept apart from muteAll: turning that off brings back exactly these. */
  muted: ReadonlySet<string>;
}

const KEY = 'pokerclause.callAudio';

function load(): CallAudioState {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { muteAll?: unknown; muted?: unknown };
      return { muteAll: v.muteAll === true, muted: new Set(Array.isArray(v.muted) ? v.muted.filter((x): x is string => typeof x === 'string') : []) };
    }
  } catch {
    // Storage blocked or garbled — everyone on.
  }
  return { muteAll: false, muted: new Set() };
}

let state: CallAudioState = typeof window === 'undefined' ? { muteAll: false, muted: new Set() } : load();
const listeners = new Set<() => void>();

function set(next: CallAudioState): void {
  state = next;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ muteAll: next.muteAll, muted: [...next.muted] }));
  } catch {
    // Storage blocked — it holds until the page reloads.
  }
  for (const l of listeners) l();
}

/** Whether this player's voice is silenced for this viewer. */
export function isPeerMuted(userId: string | null | undefined, s: CallAudioState = state): boolean {
  return s.muteAll || (!!userId && s.muted.has(userId));
}

/** The whole call, off or back on (the players muted one by one stay muted). */
export function toggleMuteAll(): void {
  set({ ...state, muteAll: !state.muteAll });
}

/**
 * One player, off or back on. Turning someone back on while the whole call
 * is muted means "just them": the call comes back on with everyone else
 * (`everyone`, the user ids in the call) muted one by one.
 */
export function togglePeer(userId: string, everyone: readonly string[]): void {
  if (state.muteAll) {
    set({ muteAll: false, muted: new Set(everyone.filter((id) => id !== userId)) });
    return;
  }
  const muted = new Set(state.muted);
  if (muted.has(userId)) muted.delete(userId);
  else muted.add(userId);
  set({ ...state, muted });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The current state, re-rendering on every change. */
export function useCallAudio(): CallAudioState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

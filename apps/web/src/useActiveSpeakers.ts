import { useEffect, useRef, useState } from 'react';

export interface SpeakerStreamEntry {
  id: string;
  stream: MediaStream;
}

const POLL_MS = 200;
// How long an id stays "active" after its last loud sample — smooths over
// natural pauses between words so the speaker bar doesn't flicker.
const HANGOVER_MS = 700;
// Average byte frequency data, 0-255. Chromium's fake mic (used by our own
// e2e tests) emits a steady tone well above this; a real quiet room reads
// well under it.
const VOLUME_THRESHOLD = 12;

let sharedAudioContext: AudioContext | null = null;
/**
 * Shared across every user of this module (also called directly, and
 * synchronously, from useVoiceChat.ts's joinCall — see that call site's own
 * comment for why: a browser's autoplay policy only reliably lets
 * `resume()` actually take effect when it's called synchronously inside a
 * real user gesture, and by the time this hook's own effect would call it,
 * that gesture is long gone).
 */
export function getSharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;
  sharedAudioContext ??= new AudioContext();
  if (sharedAudioContext.state === 'suspended') void sharedAudioContext.resume();
  return sharedAudioContext;
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

interface AnalysisNode {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
}

/**
 * Lightweight active-speaker detection over a set of live MediaStreams —
 * used to pick who appears in the collapsed camera speaker bar (see
 * SpeakerBar.tsx and Table.tsx) once there are more than 4 human cameras
 * on and the viewer's screen is phone-sized. Returns ids currently
 * considered "speaking," most-recently-active first.
 *
 * Deliberately does nothing at all while `enabled` is false (the common
 * case — normal screens, or ≤4 camera users): no AudioContext, no
 * analysis loop, no per-peer nodes. That's the whole efficiency story
 * here; this only ever runs for the specific combination it exists for.
 */
export function useActiveSpeakers(entries: SpeakerStreamEntry[], enabled: boolean): string[] {
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const nodesRef = useRef(new Map<string, AnalysisNode>());
  const lastActiveRef = useRef(new Map<string, number>());
  const activeIdsRef = useRef<string[]>([]);

  // `entries` is a fresh array every render of the caller — key on the
  // actual (id, stream) pairs so this effect only redoes work when the
  // real set of streams to analyze changes.
  const entryKey = entries
    .map((e) => `${e.id}:${e.stream.id}`)
    .sort()
    .join(',');

  useEffect(() => {
    const nodes = nodesRef.current;
    const lastActive = lastActiveRef.current;

    if (!enabled) {
      for (const node of nodes.values()) {
        node.source.disconnect();
        node.analyser.disconnect();
      }
      nodes.clear();
      lastActive.clear();
      activeIdsRef.current = [];
      setActiveIds((prev) => (prev.length ? [] : prev));
      return;
    }

    const ctx = getSharedAudioContext();
    if (!ctx) return;

    const currentIds = new Set(entriesRef.current.map((e) => e.id));
    for (const [id, node] of nodes) {
      if (currentIds.has(id)) continue;
      node.source.disconnect();
      node.analyser.disconnect();
      nodes.delete(id);
      lastActive.delete(id);
    }
    for (const entry of entriesRef.current) {
      if (nodes.has(entry.id) || entry.stream.getAudioTracks().length === 0) continue;
      try {
        const source = ctx.createMediaStreamSource(entry.stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        nodes.set(entry.id, { source, analyser, data: new Uint8Array(analyser.frequencyBinCount) });
      } catch {
        // A stream that can't be analyzed (e.g. already closed) just never
        // shows as "speaking" — Table.tsx's backfill covers the slot.
      }
    }

    const interval = window.setInterval(() => {
      const now = Date.now();
      for (const [id, node] of nodes) {
        node.analyser.getByteFrequencyData(node.data);
        let sum = 0;
        for (const v of node.data) sum += v;
        if (sum / node.data.length >= VOLUME_THRESHOLD) lastActive.set(id, now);
      }
      const next = [...lastActive.entries()]
        .filter(([, at]) => now - at <= HANGOVER_MS)
        .sort(([, a], [, b]) => b - a)
        .map(([id]) => id);
      if (!sameOrder(next, activeIdsRef.current)) {
        activeIdsRef.current = next;
        setActiveIds(next);
      }
    }, POLL_MS);

    return () => window.clearInterval(interval);
  }, [enabled, entryKey]);

  // Full teardown on unmount — the per-run effect cleanup above only ever
  // clears the interval, not the analysis nodes (kept alive across
  // entry-set changes so an unrelated peer joining/leaving doesn't
  // reconnect everyone else's still-valid node).
  useEffect(
    () => () => {
      for (const node of nodesRef.current.values()) {
        node.source.disconnect();
        node.analyser.disconnect();
      }
      nodesRef.current.clear();
    },
    [],
  );

  return activeIds;
}

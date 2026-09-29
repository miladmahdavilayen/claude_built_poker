/**
 * Mirrors `SELECTABLE_BOT_POLICIES`/`BOT_PERSONA_LABELS` in
 * apps/server/src/game/liveTable.ts (small, stable list — duplicated
 * rather than shared over the wire; the server is authoritative and
 * rejects any persona id it doesn't recognize regardless of what this
 * list offers).
 */
export const BOT_PERSONAS: readonly { id: string; label: string }[] = [
  { id: 'allan-keating', label: 'Allan Keating' },
  { id: 'nit', label: 'The Nit' },
  { id: 'calling-station', label: 'Calling Station' },
  { id: 'maniac', label: 'Maniac' },
  { id: 'shove-monkey', label: 'Shove Monkey' },
  { id: 'short-stacker', label: 'Short Stacker' },
  { id: 'check-fold', label: 'Pushover' },
  { id: 'random-legal', label: 'Wildcard' },
];

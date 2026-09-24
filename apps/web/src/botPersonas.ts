/**
 * Mirrors `SELECTABLE_BOT_POLICIES`/`BOT_PERSONA_LABELS` in
 * apps/server/src/game/liveTable.ts (small, stable list — duplicated
 * rather than shared over the wire; the server is authoritative and
 * rejects any persona id it doesn't recognize regardless of what this
 * list offers).
 */
export const BOT_PERSONAS: readonly { id: string; label: string; description: string }[] = [
  { id: 'nit', label: 'The Nit', description: 'Only plays premium hands, folds the rest' },
  { id: 'calling-station', label: 'Calling Station', description: 'Calls almost everything, rarely folds' },
  { id: 'maniac', label: 'Maniac', description: 'Bets and raises aggressively and often' },
  { id: 'shove-monkey', label: 'Shove Monkey', description: 'Raises all-in whenever it can' },
  { id: 'short-stacker', label: 'Short Stacker', description: 'Push-or-fold, no in-between' },
  { id: 'check-fold', label: 'Pushover', description: 'Checks when free, folds to any bet' },
  { id: 'random-legal', label: 'Wildcard', description: 'Picks a random legal action' },
  { id: 'allan-keating', label: 'Allan Keating', description: 'Plays purely by equity, pot odds, position, and stack depth' },
];

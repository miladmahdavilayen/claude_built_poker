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

/**
 * The owner's test players (the admin's only — the server refuses anyone else): they always check or call, so every
 * hand goes to a showdown, and each turns on a "camera" a few seconds after sitting down — its own short looping clip
 * (testBotCameras.ts). For trying out cameras, sound, the dealer and the showdown without a table of people.
 * Mirrors @pokerclause/sim's TEST_CAMERA_BOTS (in the same order as their clips).
 */
export const TEST_BOT_PERSONAS: readonly { id: string; label: string }[] = [
  { id: 'test-cam-ava', label: 'Test Ava (camera, always calls)' },
  { id: 'test-cam-ben', label: 'Test Ben (camera, always calls)' },
  { id: 'test-cam-cleo', label: 'Test Cleo (camera, always calls)' },
  { id: 'test-cam-dev', label: 'Test Dev (camera, always calls)' },
  { id: 'test-cam-eli', label: 'Test Eli (camera, always calls)' },
  { id: 'test-cam-fay', label: 'Test Fay (camera, always calls)' },
  { id: 'test-cam-gus', label: 'Test Gus (camera, always calls)' },
];

import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { BotPolicy, SeatView } from '../types.js';

/**
 * The owner's test players: they never fold and never raise — check when
 * they can, call otherwise (all in for less when that's all they have) — so
 * every hand they're in goes to a showdown. At the table each one also
 * "turns on a camera" (a short looping clip — the web app's
 * testBotCameras.ts), for trying out cameras, the dealer and the showdown
 * without a table full of people. Only the admin can seat them (the
 * server's add-bot handler).
 */
function checkCaller(name: string): BotPolicy {
  return {
    name,
    decide(view: SeatView, legal: LegalActions): PlayerAction {
      const seatId = view.seatId;
      if (legal.canCheck) return { seatId, type: 'check' };
      if (legal.canCall) return { seatId, type: 'call' };
      return { seatId, type: 'fold' };
    },
  };
}

/** One per test camera clip (public/test-cams/cam-1…7.mp4, in this order). */
export const TEST_CAMERA_BOT_NAMES = ['ava', 'ben', 'cleo', 'dev', 'eli', 'fay', 'gus'] as const;

export const TEST_CAMERA_BOTS: readonly BotPolicy[] = TEST_CAMERA_BOT_NAMES.map((n) => checkCaller(`test-cam-${n}`));

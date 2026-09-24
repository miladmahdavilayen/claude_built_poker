/**
 * Public API for reusing the simulation harness's bot decision logic
 * elsewhere — specifically, `apps/server`'s "computer players" feature
 * (see LiveTable's `addBot`/`playBotTurn`) drives real, live seats with
 * these exact same policies, so a bot behaves identically whether it's
 * grinding a million fuzz-test hands or sitting at a table with a human.
 */
export type { BotPolicy, SeatView, SeatViewSeat } from './types.js';
export { projectSeatView } from './projection.js';
export {
  ALL_BOT_POLICIES,
  adversarial,
  allanKeating,
  callingStation,
  checkFold,
  maniac,
  nit,
  randomLegal,
  shortStacker,
  shoveMonkey,
} from './bots/index.js';

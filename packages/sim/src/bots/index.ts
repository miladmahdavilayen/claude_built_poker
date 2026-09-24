import type { BotPolicy } from '../types.js';
import { adversarial } from './adversarial.js';
import { allanKeating } from './allanKeating.js';
import { callingStation } from './callingStation.js';
import { checkFold } from './checkFold.js';
import { maniac } from './maniac.js';
import { nit } from './nit.js';
import { randomLegal } from './randomLegal.js';
import { shortStacker } from './shortStacker.js';
import { shoveMonkey } from './shoveMonkey.js';

export const ALL_BOT_POLICIES: readonly BotPolicy[] = [
  randomLegal,
  callingStation,
  nit,
  maniac,
  shoveMonkey,
  checkFold,
  shortStacker,
  allanKeating,
  adversarial,
];

export {
  adversarial,
  allanKeating,
  callingStation,
  checkFold,
  maniac,
  nit,
  randomLegal,
  shortStacker,
  shoveMonkey,
};

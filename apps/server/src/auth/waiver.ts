import { WAIVER_VERSION } from '@pokerclause/shared';
import type { UserRecord } from '../db/store.js';

/** A Google player who hasn't agreed to the current friendly-game waiver yet — they can't play until they do. Guests and the owner are never asked. */
export function needsWaiver(user: UserRecord): boolean {
  return user.googleId !== null && user.role !== 'admin' && user.waiver?.version !== WAIVER_VERSION;
}

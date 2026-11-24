// Where each player at the table is looking, as their own 3D view reports it
// (Table.tsx passes on the server's 'player-look'): radians from straight
// ahead at the table's middle. Read by the scene every frame — kept out of
// React state, so a player glancing about never re-renders the page — and
// free of Three.js, so the page can fill it without loading the 3D table.

export interface PlayerLook {
  yaw: number;
  pitch: number;
}

const looks = new Map<string, PlayerLook>();

export function setPlayerLook(userId: string, yaw: number, pitch: number): void {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
  looks.set(userId, { yaw, pitch });
}

/** A player with no look reported (the 2D table, standing, or just arrived) faces the table's middle. */
export function playerLook(userId: string | null): PlayerLook | null {
  return userId === null ? null : (looks.get(userId) ?? null);
}

export function clearPlayerLooks(): void {
  looks.clear();
}

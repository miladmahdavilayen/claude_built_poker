/**
 * The characters a human player can pick before sitting down, one each at a
 * table: built from the raw downloads by scripts/build-player-characters.mjs
 * into apps/web/public/models/players/<id>.glb and <id>.webp (its icon).
 */
export const PLAYER_CHARACTERS: readonly { id: string; name: string; ownerOnly?: boolean }[] = [
  // The owner's alone: no one else sees it on the list, and the server refuses it to anyone else.
  { id: 'the-boss', name: 'The Boss', ownerOnly: true },
  { id: 'aj', name: 'AJ' },
  { id: 'eve', name: 'Eve' },
  { id: 'kachujin', name: 'Kachujin' },
  { id: 'remy', name: 'Remy' },
  { id: 'ch17', name: 'Mason' },
  { id: 'ch31', name: 'Theo' },
  { id: 'ch46', name: 'Bunny' },
  { id: 'marker', name: 'Marker' },
  { id: 'michelle', name: 'Michelle' },
];
export const PLAYER_CHARACTER_IDS = PLAYER_CHARACTERS.map((c) => c.id) as [string, ...string[]];

/** Whether someone may have this character: the owner any of them, anyone else any but the owner's own. */
export function mayPickCharacter(id: string, isOwner: boolean): boolean {
  return isOwner || !PLAYER_CHARACTERS.find((c) => c.id === id)?.ownerOnly;
}

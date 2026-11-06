import { PLAYER_CHARACTERS, mayPickCharacter } from '@pokerclause/shared/characters';

/** The characters this viewer could pick: no one at this table has them yet, and the owner's own only for the owner. */
export function freeCharacters(seats: readonly { character: string | null }[], isOwner: boolean): readonly { id: string; name: string }[] {
  return PLAYER_CHARACTERS.filter((c) => mayPickCharacter(c.id, isOwner) && !seats.some((s) => s.character === c.id));
}

export const characterIconUrl = (id: string): string => `/models/players/${id}.webp`;

/**
 * Who you'll be at the table: a small picture and a name for each character
 * still free. First to pick one keeps it until they switch or leave, so a choice
 * can vanish from here the moment someone else makes it.
 */
export function CharacterPicker({
  characters,
  selected,
  onSelect,
}: {
  characters: readonly { id: string; name: string }[];
  selected: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="character-picker" role="radiogroup" aria-label="Choose your character">
      {characters.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={selected === c.id}
          data-testid={`character-${c.id}`}
          className={`character-option${selected === c.id ? ' character-option--selected' : ''}`}
          onClick={() => onSelect(c.id)}
        >
          <img src={characterIconUrl(c.id)} alt="" width={64} height={64} decoding="async" />
          <span>{c.name}</span>
        </button>
      ))}
    </div>
  );
}

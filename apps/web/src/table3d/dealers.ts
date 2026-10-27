import { useEffect, useState } from 'react';

/**
 * The house dealer characters a table can use: Mixamo characters in
 * public/models/dealers, listed (id, name, file) in its index.json. The
 * table's own choice is its `houseDealer` setting; with none, it's the
 * first in the list — and with an empty list, the built-in dealer.
 */
export interface DealerCharacter {
  id: string;
  name: string;
  file: string;
  /** A VIP dealer: listed in the picker's own section. */
  vip?: boolean;
}

let list: Promise<DealerCharacter[]> | null = null;

function loadList(): Promise<DealerCharacter[]> {
  // Always asked again (a quick "has it changed?" to the server): a browser holding an older copy for weeks
  // (nginx kept it 30 days, once) would otherwise go on missing every character added since.
  list ??= fetch('/models/dealers/index.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<DealerCharacter[]>) : []))
    .catch(() => []);
  return list;
}

export function useDealerCharacters(): DealerCharacter[] {
  const [chars, setChars] = useState<DealerCharacter[]>([]);
  useEffect(() => {
    let live = true;
    void loadList().then((l) => {
      if (live) setChars(l);
    });
    return () => {
      live = false;
    };
  }, []);
  return chars;
}

/** The model file for a table's setting — its chosen character, or the first in the list (VIP first) if it has none or it's gone. */
export function dealerModelUrl(chars: readonly DealerCharacter[], setting: string | undefined): string | null {
  const pick = chars.find((c) => c.id === setting) ?? orderedDealers(chars)[0];
  return pick ? `/models/dealers/${pick.file}` : null;
}

/** Whether a table's dealer (its setting, as dealerModelUrl picks it) is a VIP character — whose table is the VIP room. */
export function dealerIsVip(chars: readonly DealerCharacter[], setting: string | undefined): boolean {
  return (chars.find((c) => c.id === setting) ?? orderedDealers(chars)[0])?.vip === true;
}

/** VIP characters first, then the rest, each in list order. */
export function orderedDealers(chars: readonly DealerCharacter[]): DealerCharacter[] {
  return [...chars.filter((c) => c.vip), ...chars.filter((c) => !c.vip)];
}

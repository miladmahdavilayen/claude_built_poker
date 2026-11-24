import { useEffect, useState } from 'react';

/** Whether a media query matches right now, kept up to date (a resize, a phone turned on its side). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** A phone held upright. */
export const PHONE_PORTRAIT = '(max-width: 767px) and (orientation: portrait) and (pointer: coarse)';
/** A phone held on its side: wide, and very short. */
export const PHONE_LANDSCAPE = '(max-height: 500px) and (orientation: landscape) and (pointer: coarse)';

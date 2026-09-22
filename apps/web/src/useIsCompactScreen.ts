import { useEffect, useState } from 'react';

// A phone-sized viewport — tablets and up (≥768px) always get full
// per-seat video regardless of camera count; see useActiveSpeakers.ts and
// Table.tsx for how this feeds the camera-collapse decision.
const COMPACT_QUERY = '(max-width: 767px)';

/** Live viewport-width signal, kept in sync via matchMedia (covers resize AND orientation changes for free). */
export function useIsCompactScreen(): boolean {
  const [isCompact, setIsCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(COMPACT_QUERY);
    const onChange = (): void => setIsCompact(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isCompact;
}

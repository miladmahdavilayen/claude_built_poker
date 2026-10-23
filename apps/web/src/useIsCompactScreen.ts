import { useEffect, useState } from 'react';

// A phone-sized viewport — narrow (a phone held upright), or a short touch
// screen (a phone held sideways: 844 wide but only ~390 tall, where the full action bar
// alone would leave the table too little height for its seats and board —
// see useTableLayout.ts; a short desktop window keeps the desktop bar). Tablets and up (≥768px wide and >500px tall)
// always get full per-seat video regardless of camera count; see
// useActiveSpeakers.ts and Table.tsx for how this feeds the camera-collapse
// decision.
const COMPACT_QUERY = '(max-width: 767px), (max-height: 500px) and (pointer: coarse)';

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

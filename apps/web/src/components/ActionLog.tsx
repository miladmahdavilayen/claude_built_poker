import type { ProjectedGameEvent, ProjectedSeat } from '@pokerclause/shared';
import { useEffect, useRef } from 'react';
import { describeEvent } from '../eventLog.js';

export function ActionLog({ events, seats }: { events: readonly ProjectedGameEvent[]; seats: readonly ProjectedSeat[] }): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const seatName = (seatId: number): string => seats.find((s) => s.seatId === seatId)?.displayName ?? `Seat ${String(seatId)}`;
  const lines = events.map((e) => describeEvent(e, seatName)).filter((line): line is string => line !== null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  return (
    <div className="action-log">
      {lines.length === 0 && <div className="action-log-empty">No hands played yet.</div>}
      {lines.map((line, i) => (
        <div key={i} className={line.startsWith('—') ? 'action-log-divider' : 'action-log-line'}>
          {line}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

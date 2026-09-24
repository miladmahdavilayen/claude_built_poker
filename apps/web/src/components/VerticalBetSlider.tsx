import { useRef, useState } from 'react';

// Purely decorative denomination ladder for the bill-stack visual — NOT a
// literal count of real bills (a $1,500 raise would never render as 1,500
// notes). Each of the MAX_LAYERS slots on the track always maps to the same
// tier regardless of how many are currently visible, so a bill's color never
// changes after it's appeared — only new, higher-tier bills stack on top as
// the amount grows. Loosely echoes CHIP_DENOMINATIONS' palette (chips.ts) so
// the two "money" visuals in the app feel related without being identical.
const BILL_TIERS: readonly { label: string; base: string; edge: string }[] = [
  { label: '$1', base: '#3fae5c', edge: '#dff5e4' },
  { label: '$5', base: '#3d6fd1', edge: '#e2ebff' },
  { label: '$10', base: '#d97b32', edge: '#ffe9d6' },
  { label: '$20', base: '#2f9e8e', edge: '#d8fff9' },
  { label: '$50', base: '#5b5fd6', edge: '#e6e6ff' },
  { label: '$100', base: '#e0a730', edge: '#fff3d6' },
  { label: '$500', base: '#9b4fd1', edge: '#f3e2ff' },
  { label: '$1K', base: '#d8544b', edge: '#ffe0dd' },
  { label: '$5K', base: '#1f9a9a', edge: '#d6fffb' },
  { label: '$10K', base: '#565b68', edge: '#e7e9ee' },
];

const MAX_LAYERS = 12;

function tierForLayer(index: number): (typeof BILL_TIERS)[number] {
  const i = Math.min(BILL_TIERS.length - 1, Math.floor((index / MAX_LAYERS) * BILL_TIERS.length));
  return BILL_TIERS[i]!;
}

// Fires a barely-there tick on real devices that support it (mostly
// Android; iOS Safari has no Vibration API) each time a drag crosses a step
// boundary — a physical "click" to match a real slider's feel while
// thumbing an amount, not a per-pixel buzz. Feature-detected and wrapped:
// this is pure polish, never worth letting a throw interrupt a drag.
function tickHaptic(): void {
  try {
    navigator.vibrate?.(4);
  } catch {
    /* not supported — silently skip */
  }
}

export function VerticalBetSlider({
  min,
  max,
  step,
  value,
  onChange,
  formatValue,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  formatValue: (value: number) => string;
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const span = Math.max(max - min, 1);
  const fraction = Math.min(1, Math.max(0, (value - min) / span));
  const layerCount = Math.max(1, Math.round(fraction * (MAX_LAYERS - 1)) + 1);

  // Deliberately not memoized: this only runs on an active drag (a handful
  // of pointer events, not a hot render loop), and staying a plain closure
  // means it always sees the current `value` prop — no stale-ref bookkeeping
  // needed to detect "did this drag tick actually change the amount".
  const dragTo = (clientY: number): void => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height));
    const raw = min + f * (max - min);
    const stepped = Math.round(raw / step) * step;
    const next = Math.min(Math.max(stepped, min), max);
    if (next !== value) {
      tickHaptic();
      onChange(next);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragTo(e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    dragTo(e.clientY);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const bump = (delta: number): void => onChange(Math.min(Math.max(value + delta, min), max));
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      bump(step);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      bump(-step);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      bump(step * 5);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      bump(-step * 5);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(min);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(max);
    }
  };

  const pct = fraction * 100;

  return (
    <div
      ref={trackRef}
      className={`vbs-track${dragging ? ' vbs-track--dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
      aria-label="Bet amount"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={formatValue(value)}
    >
      <div className="vbs-fill" style={{ height: `${pct}%` }}>
        {Array.from({ length: layerCount }, (_, i) => {
          const tier = tierForLayer(i);
          return (
            <div key={i} className="vbs-bill" style={{ background: tier.base, borderColor: tier.edge, color: tier.edge }}>
              {tier.label}
            </div>
          );
        })}
      </div>
      <div className="vbs-thumb" style={{ bottom: `${pct}%` }} aria-hidden="true" />
      <div className="vbs-bubble" style={{ bottom: `${pct}%` }} aria-hidden="true">
        {formatValue(value)}
      </div>
    </div>
  );
}

import { useRef, useState } from 'react';

// Realistic-ish greenback palette — real US currency reads as "green"
// regardless of denomination, so unlike an earlier version of this
// component, color is NOT used to encode the amount (that was a rainbow
// per-tier scheme that read as gimmicky/confusing). These three shades just
// cycle down the stack so individual bills are visually distinguishable —
// the way overlapping real bills look slightly different from wear and
// lighting — purely decorative. The actual amount is only ever communicated
// via the numeric input right above the track, never by bill color or count.
const BILL_SHADES: readonly { base: string; edge: string }[] = [
  { base: '#2f7a4f', edge: '#bfe6c9' },
  { base: '#28694a', edge: '#a9dab8' },
  { base: '#357f57', edge: '#cdeed4' },
];

const MAX_LAYERS = 14;

function shadeForLayer(index: number): (typeof BILL_SHADES)[number] {
  return BILL_SHADES[index % BILL_SHADES.length]!;
}

// The drag maps pointer position to a dollar amount on a LOGARITHMIC curve,
// not a straight line. A poker bet range routinely spans two-plus orders of
// magnitude (e.g. a $10 min raise up to a $2,000 all-in) — a linear map
// forces one fixed "dollars per pixel" across that whole span, so hitting
// an exact small/medium amount (the sizes players actually fine-tune) is
// just as twitchy as hitting a round number near the max. Logarithmic
// spacing gives the low/common end of the range far more pixels per dollar
// and compresses the rarely-precision-adjusted top end — while the physical
// ends of the track still land exactly on `min` and `max`. This is the same
// scaling audio faders and price-range sliders use, and it's just a
// formula: no extra state, no library, cheap to compute on every pointer
// move.
function curveToValue(fraction: number, min: number, max: number): number {
  if (max <= min) return min;
  if (min <= 0) return min + fraction * (max - min); // degenerate guard, e.g. a free-roll edge case
  return min * Math.pow(max / min, fraction);
}
function valueToFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  if (min <= 0) return Math.min(1, Math.max(0, (value - min) / (max - min)));
  return Math.min(1, Math.max(0, Math.log(value / min) / Math.log(max / min)));
}

// Fires a barely-there tick on real devices that support it (mostly
// Android; iOS Safari has no Vibration API) as a drag crosses a step
// boundary — a physical "click" to match a real slider's feel. Throttled:
// with $1 precision, a fast drag through the (compressed, high-value) top
// of the log curve can cross many steps in a single pointermove batch, and
// firing a real vibration per dollar there would feel like a buzz, not a
// click. Feature-detected and wrapped: this is pure polish, never worth
// letting a throw interrupt a drag.
let lastHapticAt = 0;
function tickHaptic(): void {
  const now = Date.now();
  if (now - lastHapticAt < 45) return;
  lastHapticAt = now;
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

  const fraction = valueToFraction(value, min, max);
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
    const raw = curveToValue(f, min, max);
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
      bump(step * 10);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      bump(-step * 10);
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
          const shade = shadeForLayer(i);
          return (
            <div key={i} className="vbs-bill" style={{ background: shade.base, borderColor: shade.edge }}>
              <span className="vbs-bill-mark" style={{ color: shade.edge }}>
                $
              </span>
            </div>
          );
        })}
      </div>
      <div className="vbs-thumb" style={{ bottom: `${pct}%` }} aria-hidden="true">
        <span className="vbs-thumb-mark">$</span>
      </div>
    </div>
  );
}

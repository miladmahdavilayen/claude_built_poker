import type { Card } from '@pokerclause/engine';
import { useState } from 'react';
import { BoardAndPot } from '../components/BoardAndPot.js';
import { TrophyCelebration } from '../components/TrophyCelebration.js';
import { playTrophyFanfare, playWinFanfare } from '../sound.js';
import { WIN_TIER_NAMES, type WinTier } from '../winTiers.js';

const BOARDS: Record<Exclude<WinTier, 0>, Card[]> = {
  1: ['9h', 'Ts', 'Jd', '2c', '5h'],
  2: ['2h', '7h', 'Jh', 'Kc', '4h'],
  3: ['Qs', 'Qd', '7c', '7h', '2s'],
  4: ['8s', '8d', '8h', 'Kc', '3d'],
  5: ['5s', '6s', '7s', 'Kd', '2h'],
  6: ['Ts', 'Js', 'Qs', '4d', '9c'],
};

/**
 * Dev-only (registered in App.tsx under import.meta.env.DEV): fires each
 * trophy celebration on a mock felt, so the show and its sound can be
 * judged without waiting for a real straight-or-better at a live table.
 */
export function CelebrationPreviewPage(): React.JSX.Element {
  const [shown, setShown] = useState<{ tier: WinTier; key: number } | null>(null);
  const tiers = [1, 2, 3, 4, 5, 6] as const;

  const fire = (tier: WinTier): void => {
    setShown({ tier, key: Date.now() });
    if (tier === 0) playWinFanfare();
    else playTrophyFanfare(tier);
  };

  return (
    <div className="table-page" style={{ minHeight: '100vh' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 16 }}>
        <button type="button" onClick={() => fire(0)}>
          Ordinary win
        </button>
        {tiers.map((t) => (
          <button key={t} type="button" className="primary" onClick={() => fire(t)}>
            {WIN_TIER_NAMES[t]}
          </button>
        ))}
      </div>
      <div className="felt" style={{ minHeight: 420 }}>
        <BoardAndPot board={shown && shown.tier > 0 ? BOARDS[shown.tier as Exclude<WinTier, 0>] : []} pots={[]} liveTotal={4200} />
        {shown && shown.tier > 0 && <TrophyCelebration key={shown.key} tier={shown.tier as Exclude<WinTier, 0>} amount={4200} />}
        {shown && shown.tier === 0 && (
          <div key={shown.key} className="viewer-win-banner">
            <div className="viewer-win-text">You Win!</div>
            <div className="viewer-win-amount">+$42.00</div>
          </div>
        )}
      </div>
    </div>
  );
}

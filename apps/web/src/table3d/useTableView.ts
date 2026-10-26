import { useCallback, useEffect, useState } from 'react';
import {
  hasWebGL,
  initialAutoTier,
  loadReduceMotion,
  loadSlowAnimations,
  loadPinnedTier,
  loadViewChoice,
  lowerTier,
  saveReduceMotion,
  saveSlowAnimations,
  saveViewChoice,
  type QualityTier,
  type TableViewChoice,
  type View3dMode,
} from './quality.js';

/** Slower than this (median frame, ms) for a whole sample, and the 3D table steps down a tier. */
const SLOW_FRAME_MS = 30;

export interface TableView {
  choice: TableViewChoice;
  setChoice: (c: TableViewChoice) => void;
  /** What's actually showing: the 2D table, or a 3D view at the quality this device keeps smooth. */
  effective: '2d' | { mode: View3dMode; tier: QualityTier };
  /** Why it's 2D when 3D was asked for, if it is. */
  fallbackReason: 'no-webgl' | 'too-slow' | null;
  reduceMotion: boolean;
  setReduceMotion: (on: boolean) => void;
  slowAnimations: boolean;
  setSlowAnimations: (on: boolean) => void;
  /** The scene's frame-time reports. */
  reportFrameTime: (ms: number) => void;
  /** WebGL failed to start. */
  reportFailure: () => void;
}

/** The viewer's table view (the View menu), the 3D quality stepping down on a device that can't keep up. */
export function useTableView(): TableView {
  const [choice, setChoiceState] = useState<TableViewChoice>(loadViewChoice);
  const [pinned] = useState(loadPinnedTier);
  const [autoTier, setAutoTier] = useState<QualityTier | '2d'>(() => pinned ?? initialAutoTier());
  // Only looked into when a 3D view is wanted: the check itself makes a WebGL context.
  const [failed, setFailed] = useState(() => loadViewChoice() !== '2d' && !hasWebGL());
  const [reduceMotion, setReduceMotionState] = useState(loadReduceMotion);
  const [systemReduce, setSystemReduce] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [slowAnimations, setSlowState] = useState(loadSlowAnimations);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = (): void => setSystemReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const setChoice = useCallback((c: TableViewChoice) => {
    setChoiceState(c);
    saveViewChoice(c);
    // Choosing 3D again gives it a fresh chance at the device's own tier.
    if (c !== '2d') {
      setAutoTier((t) => (t === '2d' ? initialAutoTier() : t));
      if (!hasWebGL()) setFailed(true);
    }
  }, []);

  const reportFrameTime = useCallback(
    (ms: number) => {
      if (pinned || ms < SLOW_FRAME_MS) return;
      setAutoTier((t) => (t === '2d' ? t : (lowerTier(t) ?? '2d')));
    },
    [pinned],
  );

  const reportFailure = useCallback(() => setFailed(true), []);

  let effective: TableView['effective'];
  let fallbackReason: TableView['fallbackReason'] = null;
  if (choice === '2d') effective = '2d';
  else if (failed) {
    effective = '2d';
    fallbackReason = 'no-webgl';
  } else if (autoTier === '2d') {
    effective = '2d';
    fallbackReason = 'too-slow';
  } else effective = { mode: choice, tier: autoTier };

  return {
    choice,
    setChoice,
    effective,
    fallbackReason,
    reduceMotion: reduceMotion || systemReduce,
    setReduceMotion: (on) => {
      setReduceMotionState(on);
      saveReduceMotion(on);
    },
    slowAnimations,
    setSlowAnimations: (on) => {
      setSlowState(on);
      saveSlowAnimations(on);
    },
    reportFrameTime,
    reportFailure,
  };
}

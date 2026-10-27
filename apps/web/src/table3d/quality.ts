// The viewer's choice of view (the table header's View menu) — the classic
// 2D table, 3D seated (your own eyes at your seat, looking around by
// dragging) or 3D standing (from your seat, on your feet, the whole table
// in view) — and the 3D table's quality tier, which is picked for the
// device on its own: it starts from a guess and steps down while the
// measured frame time stays too slow (see TableScene3D's frame monitor),
// all the way to the 2D table on a device that can't keep up even on Low.
// No WebGL at all means 2D.

export type QualityTier = 'high' | 'medium' | 'low';
export type TableViewChoice = '2d' | 'seated' | 'standing';
export type View3dMode = 'seated' | 'standing';
/** The table's look: the classic green-felt room, or the high-limit VIP room (a VIP house dealer's table). */
export type TableTheme = 'classic' | 'vip';

export interface TierSettings {
  /** Device-pixel-ratio cap. */
  maxDpr: number;
  /**
   * The most pixels drawn per frame: a bigger table (a large window, now that
   * the table always fills the screen) is drawn at a lower resolution and
   * scaled up, so a slow device's frame time doesn't grow with its screen.
   */
  maxPixels: number;
  antialias: boolean;
  /** Shadow-map size; 0 turns shadow maps off (blob shadows instead). */
  shadowMapSize: number;
  /** Procedural texture size, px (never over 1024). */
  textureSize: number;
  /** The house dealer's character and animations. */
  houseDealer: boolean;
  /** Frames per second while nothing is moving (the dealer's idle breathing). */
  idleFps: number;
}

export const TIERS: Record<QualityTier, TierSettings> = {
  high: { maxDpr: 3, maxPixels: Infinity, antialias: true, shadowMapSize: 2048, textureSize: 1024, houseDealer: true, idleFps: 30 },
  medium: { maxDpr: 2.5, maxPixels: Infinity, antialias: true, shadowMapSize: 1024, textureSize: 512, houseDealer: true, idleFps: 24 },
  low: { maxDpr: 1.25, maxPixels: 520_000, antialias: false, shadowMapSize: 0, textureSize: 256, houseDealer: true, idleFps: 15 },
};

const VIEW_KEY = 'pokerclause.tableView';
const MOTION_KEY = 'pokerclause.reduceMotion';
const SLOW_KEY = 'pokerclause.slowAnimations';

export function loadViewChoice(): TableViewChoice {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    if (v === '2d' || v === 'seated' || v === 'standing') return v;
    // The earlier quality choices were all the 3D table.
    if (v === 'auto' || v === 'high' || v === 'medium' || v === 'low') return 'seated';
  } catch {
    // Storage blocked — the default stands.
  }
  return 'seated';
}

export function saveViewChoice(choice: TableViewChoice): void {
  try {
    window.localStorage.setItem(VIEW_KEY, choice);
  } catch {
    // Storage blocked — it just won't be remembered.
  }
}

function loadFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // Storage blocked — it just won't be remembered.
  }
}

/**
 * A fixed quality tier instead of the automatic one — for tests on a
 * GPU-less machine (whose software rendering would otherwise step itself
 * down to 2D) and for trying a tier by hand: localStorage
 * `pokerclause.tableQuality` = high | medium | low.
 */
export function loadPinnedTier(): QualityTier | null {
  try {
    const v = window.localStorage.getItem('pokerclause.tableQuality');
    return v === 'high' || v === 'medium' || v === 'low' ? v : null;
  } catch {
    return null;
  }
}

export const loadReduceMotion = (): boolean => loadFlag(MOTION_KEY);
export const saveReduceMotion = (on: boolean): void => saveFlag(MOTION_KEY, on);
export const loadSlowAnimations = (): boolean => loadFlag(SLOW_KEY);
export const saveSlowAnimations = (on: boolean): void => saveFlag(SLOW_KEY, on);

let webglSupport: boolean | null = null;
/** Whether this browser can make a WebGL2 (or WebGL) context at all — checked once. */
export function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    // The probe canvas is simply dropped — losing its context on purpose would count toward Chrome's limit.
    webglSupport = !!gl;
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

/** Auto's starting tier: a phone or a low-core machine starts at Medium; Low only once it proves slow. */
export function initialAutoTier(): QualityTier {
  const cores = navigator.hardwareConcurrency || 4;
  const small = Math.min(window.screen.width, window.screen.height) < 600;
  if (cores <= 2) return 'low';
  if (small || cores <= 4) return 'medium';
  return 'high';
}

export function lowerTier(tier: QualityTier): QualityTier | null {
  return tier === 'high' ? 'medium' : tier === 'medium' ? 'low' : null;
}

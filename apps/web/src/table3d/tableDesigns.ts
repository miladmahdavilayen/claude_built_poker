import type { TableTheme } from '@pokerclause/shared';
import { CLASSIC_FELT, MAHOGANY, OAK, PALE_OAK, VIP_FELT, WALNUT, type FeltColor, type WoodPalette } from './textures.js';

/**
 * The 3D table's designs — the owner's pick, everyone at the table sees it
 * (the table's `tableTheme` setting; the picker is components/DealerPicker.tsx).
 * Each is a whole look: the felt and its printed line, the racetrack and
 * apron's wood, the rail's leather, the metal trim (if any), the chairs, the
 * dealer's chip rack, the lighting — and which of the two rooms it stands in
 * (the classic card room under its lamp, or the VIP floor under a chandelier).
 * scene.ts builds the table from this; nothing else needs to know a design.
 */
export interface TableDesign {
  id: TableTheme;
  label: string;
  /** A line for the picker. */
  blurb: string;
  /** The picker's swatches: the felt, and the trim or rail. */
  swatch: readonly [string, string];
  /** VIP designs sit on the VIP floor (chandelier, slot machines, rug); the rest in the classic room under a lamp. */
  room: 'classic' | 'vip';
  felt: FeltColor;
  /** The felt as a CSS colour, for the room's other tables. */
  feltCss: string;
  /** The printed betting line round the felt: its colour, how strong, and whether a finer second line runs inside it. */
  line: { color: string; opacity: number; double: boolean };
  /** The racetrack and apron: grained wood in a palette, or a dark glossy lacquer. */
  wood: { kind: 'grain'; palette: WoodPalette; roughness: number } | { kind: 'lacquer'; color: string; grain: string; roughness: number };
  /** The padded rail: plain pebbled leather, or quilted with buttons. */
  rail: { quilted: boolean; color: string; button?: string; roughness: number };
  /** Metal trim round the felt, along the apron's foot, on the legs, the rack and the chairs — or none. */
  trim: { color: string; emissive: string } | null;
  /** The chairs: club chairs on chrome, or armchairs in velvet on the trim's metal — and their upholstery's colours. */
  chairs: { style: 'club' | 'velvet'; occupied: string; empty: string; hover: string };
  /** The felt lining the dealer's chip rack. */
  rackLiner: string;
  legs: { color: string; roughness: number };
  /** The room's ambient light: sky and ground colours and strength, and the spotlight over the table. */
  light: { sky: string; ground: string; intensity: number; spot: string };
}

const GOLD = { color: '#d2a344', emissive: '#4a3008' };
const CHROME = { color: '#c9ccd2', emissive: '#2a2c30' };
const BRASS = { color: '#b8893a', emissive: '#3e2a08' };
const SILVER = { color: '#dfe3e8', emissive: '#30343a' };

export const TABLE_DESIGNS: Record<TableTheme, TableDesign> = {
  classic: {
    id: 'classic',
    label: 'Classic',
    blurb: 'Green felt, an oak racetrack, a dark leather rail — the card room.',
    swatch: ['#0f5a36', '#1b1210'],
    room: 'classic',
    felt: CLASSIC_FELT,
    feltCss: '#0f5a36',
    line: { color: '#e9cf8a', opacity: 0.28, double: false },
    wood: { kind: 'grain', palette: OAK, roughness: 0.35 },
    rail: { quilted: false, color: '#1b1210', roughness: 0.48 },
    trim: null,
    chairs: { style: 'club', occupied: '#4a1018', empty: '#7a1c2c', hover: '#c4485c' },
    rackLiner: '#17171a',
    legs: { color: '#1b120c', roughness: 0.6 },
    light: { sky: '#ffe7c4', ground: '#24160e', intensity: 0.85, spot: '#ffd7a3' },
  },
  vip: {
    id: 'vip',
    label: 'VIP Burgundy',
    blurb: 'Burgundy felt, gold lines and trim, ebony, a quilted black rail — the high-limit floor.',
    swatch: ['#5a0f1c', '#d2a344'],
    room: 'vip',
    felt: VIP_FELT,
    feltCss: '#5a0f1c',
    line: { color: '#e2b65a', opacity: 0.62, double: true },
    wood: { kind: 'lacquer', color: '#1a0f0b', grain: '120,70,40', roughness: 0.16 },
    rail: { quilted: true, color: '#141011', button: '#b08a3e', roughness: 0.4 },
    trim: GOLD,
    chairs: { style: 'velvet', occupied: '#2a1a1e', empty: '#3e2a30', hover: '#9a7434' },
    rackLiner: '#2a0a10',
    legs: { color: '#0d0a0a', roughness: 0.2 },
    light: { sky: '#fff0d8', ground: '#2a1218', intensity: 1.05, spot: '#ffd7a3' },
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight Blue',
    blurb: 'Deep navy felt with a silver line, a walnut racetrack, black leather and chrome — a modern high-roller table.',
    swatch: ['#12284a', '#c9ccd2'],
    room: 'classic',
    felt: { base: [14, 34, 70], lift: [14, 24, 40] },
    feltCss: '#12284a',
    line: { color: '#c8d4e8', opacity: 0.4, double: false },
    wood: { kind: 'grain', palette: WALNUT, roughness: 0.28 },
    rail: { quilted: false, color: '#0e0e12', roughness: 0.42 },
    trim: CHROME,
    chairs: { style: 'club', occupied: '#141a2a', empty: '#1e2a44', hover: '#4a6aa8' },
    rackLiner: '#0e1422',
    legs: { color: '#15161a', roughness: 0.3 },
    light: { sky: '#e4ecff', ground: '#101a2a', intensity: 0.9, spot: '#ffe6c8' },
  },
  emerald: {
    id: 'emerald',
    label: 'Emerald Royale',
    blurb: 'Rich emerald felt, twin gold lines, mahogany, a quilted cognac rail — Monte Carlo.',
    swatch: ['#0b6a3a', '#7a3c18'],
    room: 'vip',
    felt: { base: [8, 96, 54], lift: [20, 50, 30] },
    feltCss: '#0b6a3a',
    line: { color: '#e8c466', opacity: 0.6, double: true },
    wood: { kind: 'grain', palette: MAHOGANY, roughness: 0.2 },
    rail: { quilted: true, color: '#5a2a12', button: '#d2a344', roughness: 0.38 },
    trim: GOLD,
    chairs: { style: 'velvet', occupied: '#102a1c', empty: '#1a3e2a', hover: '#9a7434' },
    rackLiner: '#0c3a22',
    legs: { color: '#2a120a', roughness: 0.25 },
    light: { sky: '#fff2dc', ground: '#122018', intensity: 1.05, spot: '#ffd7a3' },
  },
  onyx: {
    id: 'onyx',
    label: 'Black Onyx',
    blurb: 'Matte black felt, a silver line, black lacquer and a quilted white rail — Vegas high stakes.',
    swatch: ['#16161a', '#e8e6e0'],
    room: 'vip',
    felt: { base: [18, 18, 22], lift: [26, 26, 30] },
    feltCss: '#16161a',
    line: { color: '#d8dce4', opacity: 0.5, double: true },
    wood: { kind: 'lacquer', color: '#0c0c0e', grain: '90,90,100', roughness: 0.12 },
    rail: { quilted: true, color: '#e8e6e0', button: '#b8bcc4', roughness: 0.36 },
    trim: SILVER,
    chairs: { style: 'velvet', occupied: '#1a1a1e', empty: '#2a2a30', hover: '#8a8e98' },
    rackLiner: '#101014',
    legs: { color: '#0a0a0c', roughness: 0.2 },
    light: { sky: '#f4f6ff', ground: '#141418', intensity: 1.0, spot: '#fff0e0' },
  },
  saloon: {
    id: 'saloon',
    label: 'Oak Saloon',
    blurb: 'Sand-coloured felt, a pale oak racetrack, a cognac leather rail and brass — the back room of a saloon.',
    swatch: ['#b89a62', '#b8893a'],
    room: 'classic',
    felt: { base: [150, 124, 78], lift: [40, 34, 22] },
    feltCss: '#b89a62',
    line: { color: '#5a3a18', opacity: 0.35, double: false },
    wood: { kind: 'grain', palette: PALE_OAK, roughness: 0.5 },
    rail: { quilted: false, color: '#6a3a1c', roughness: 0.55 },
    trim: BRASS,
    chairs: { style: 'club', occupied: '#4a2a14', empty: '#7a4a24', hover: '#c88a48' },
    rackLiner: '#3a2a18',
    legs: { color: '#5a3a20', roughness: 0.6 },
    light: { sky: '#ffe2b0', ground: '#2a1a0c', intensity: 0.95, spot: '#ffcf90' },
  },
  imperial: {
    id: 'imperial',
    label: 'Imperial Purple',
    blurb: 'Royal purple felt, twin gold lines, black lacquer and a quilted plum rail — an emperor’s table.',
    swatch: ['#3e1a5a', '#d2a344'],
    room: 'vip',
    felt: { base: [56, 22, 92], lift: [30, 14, 40] },
    feltCss: '#3e1a5a',
    line: { color: '#e8c466', opacity: 0.6, double: true },
    wood: { kind: 'lacquer', color: '#120a16', grain: '110,70,130', roughness: 0.14 },
    rail: { quilted: true, color: '#24101e', button: '#d2a344', roughness: 0.4 },
    trim: GOLD,
    chairs: { style: 'velvet', occupied: '#20122a', empty: '#321c40', hover: '#9a7434' },
    rackLiner: '#1e0c2a',
    legs: { color: '#0c080e', roughness: 0.2 },
    light: { sky: '#f4e6ff', ground: '#1c1024', intensity: 1.05, spot: '#ffd7b0' },
  },
};

/** Every design, the two originals first. */
export const DESIGN_ORDER: readonly TableTheme[] = ['classic', 'vip', 'emerald', 'midnight', 'onyx', 'imperial', 'saloon'];

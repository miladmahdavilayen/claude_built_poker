// What the 3D table draws that the page's own floating notes must keep off
// (the players' camera screens — they're in the canvas, not the DOM), as
// boxes in the window's own px. Free of Three.js, like playerLooks.ts, so
// the page reads it without loading the 3D table.

export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

let rects: readonly ScreenRect[] = [];

export function setCanvasObstacles(next: readonly ScreenRect[]): void {
  rects = next;
}

export function canvasObstacles(): readonly ScreenRect[] {
  return rects;
}

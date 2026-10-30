import { useEffect } from 'react';

// At the table a finger is for turning the 3D view, tapping seats and
// buttons — never for selecting text. The stylesheet already says so for
// the whole table page (.table-page: user-select none, no iOS callout, no
// double-tap zoom); this is the backstop for when a browser selects anyway
// (iOS Safari's double tap and press-and-hold have both done it): any
// selection that starts, or appears, outside a text field is dropped.

/** Text fields keep their selection: you still edit what you type. */
function inTextField(node: Node | null | undefined): boolean {
  const el = node instanceof Element ? node : node?.parentElement;
  return !!el?.closest('input, textarea, [contenteditable="true"]');
}

export function useNoTableSelection(): void {
  useEffect(() => {
    const block = (ev: Event): void => {
      if (!inTextField(ev.target as Node | null)) ev.preventDefault();
    };
    const clear = (): void => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      if (inTextField(sel.anchorNode) || inTextField(document.activeElement)) return;
      sel.removeAllRanges();
    };
    document.addEventListener('selectstart', block, true);
    document.addEventListener('dblclick', block, true);
    document.addEventListener('contextmenu', block, true);
    document.addEventListener('selectionchange', clear);
    return () => {
      document.removeEventListener('selectstart', block, true);
      document.removeEventListener('dblclick', block, true);
      document.removeEventListener('contextmenu', block, true);
      document.removeEventListener('selectionchange', clear);
    };
  }, []);
}

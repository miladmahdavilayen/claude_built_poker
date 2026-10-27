import { useEffect } from 'react';

/**
 * The table's one menu (the ☰ in the top-right corner): a panel sliding in
 * from the right over the table, holding everything that isn't playing the
 * hand — your seat, the waitlist, the call for anyone not seated, the view,
 * the hand log, the owner's controls, the way back to the lobby. The table
 * itself always fills the screen (see Table.tsx); this is where the rest
 * lives.
 */
export function TableMenu({
  title,
  tags,
  onClose,
  children,
}: {
  title: string;
  tags?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="table-menu-backdrop" onClick={onClose}>
      <div className="table-menu" role="dialog" aria-label="Table menu" onClick={(e) => e.stopPropagation()}>
        <div className="table-menu-head">
          <div className="table-menu-title">
            {title}
            {tags}
          </div>
          <button type="button" className="table-menu-close" aria-label="Close menu" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="table-menu-body">{children}</div>
      </div>
    </div>
  );
}

/** One titled group of the table menu's items. */
export function TableMenuSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="table-menu-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

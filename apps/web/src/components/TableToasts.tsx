import { useCallback, useEffect, useRef, useState } from 'react';

export interface TableToast {
  id: number;
  /** A chat line, a mention of you (louder, longer), a poke at you, or a plain note from the table. */
  kind: 'chat' | 'mention' | 'poke' | 'info';
  /** Who it's from, when it's from someone. */
  title?: string | undefined;
  text: string;
}

const SHOWN_MS: Record<TableToast['kind'], number> = { chat: 4500, info: 4500, poke: 7000, mention: 9000 };
/** At most this many at once: the newest, with anything for you (a mention, a poke) kept over a plain chat line. */
const MAX_SHOWN = 2;

/** The table's passing notes: each shows for a few seconds, then goes on its own. */
export function useTableToasts(): { toasts: TableToast[]; push: (toast: Omit<TableToast, 'id'>) => void; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<TableToast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number): void => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);
  const push = useCallback(
    (toast: Omit<TableToast, 'id'>): void => {
      const id = nextId.current++;
      setToasts((prev) => {
        let all = [...prev, { ...toast, id }];
        while (all.length > MAX_SHOWN) {
          const drop = all.find((t) => t.kind === 'chat' || t.kind === 'info') ?? all[0]!;
          all = all.filter((t) => t !== drop);
        }
        return all;
      });
      timers.current.set(id, setTimeout(() => dismiss(id), SHOWN_MS[toast.kind]));
    },
    [dismiss],
  );
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) clearTimeout(t);
    };
  }, []);
  return { toasts, push, dismiss };
}

/**
 * Shown in the table's stack of notices (Table.tsx), one under another, so
 * none ever lands on another — a chat line while the chat is closed (tap it
 * to open the chat), a mention of you, a poke.
 */
export function TableToasts({ toasts, onOpenChat, onDismiss }: { toasts: readonly TableToast[]; onOpenChat: () => void; onDismiss: (id: number) => void }): React.JSX.Element {
  return (
    <>
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`table-toast table-toast--${t.kind}`}
          data-testid={`toast-${t.kind}`}
          role={t.kind === 'mention' || t.kind === 'poke' ? 'alert' : 'status'}
          onClick={() => {
            onDismiss(t.id);
            if (t.kind === 'chat' || t.kind === 'mention') onOpenChat();
          }}
        >
          <span className="table-toast-icon" aria-hidden="true">
            {t.kind === 'poke' ? '👉' : t.kind === 'mention' ? '@' : t.kind === 'chat' ? '💬' : 'ℹ︎'}
          </span>
          <span className="table-toast-body">
            {t.title && <strong className="table-toast-title">{t.title}</strong>}
            <span className="table-toast-text">{t.text}</span>
          </span>
        </button>
      ))}
    </>
  );
}

import { mentionedNames } from '@pokerclause/shared/mentions';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessageRecord } from '../types.js';

/** The `@…` being typed at the end of the draft (what's after the last `@` that starts a word), or null. */
function mentionBeingTyped(draft: string): string | null {
  const at = draft.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(draft[at - 1]!))) return null;
  const partial = draft.slice(at + 1);
  return partial.length <= 24 ? partial : null;
}

/** A message's text with every `@Name` of someone at the table picked out. */
function withMentions(message: string, names: readonly string[], myName: string | null): React.ReactNode {
  const found = mentionedNames(message, names);
  if (found.length === 0) return message;
  const out: React.ReactNode[] = [];
  const lower = message.toLowerCase();
  let i = 0;
  while (i < message.length) {
    // The earliest mention from here on; the longest name where two start at the same place.
    let next: { at: number; name: string } | null = null;
    for (const name of found) {
      const at = lower.indexOf(`@${name.toLowerCase()}`, i);
      if (at >= 0 && (!next || at < next.at)) next = { at, name };
    }
    if (!next) break;
    if (next.at > i) out.push(message.slice(i, next.at));
    const end = next.at + next.name.length + 1;
    const mine = myName !== null && next.name.toLowerCase() === myName.toLowerCase();
    out.push(
      <span key={next.at} className={`chat-mention${mine ? ' chat-mention--me' : ''}`}>
        {message.slice(next.at, end)}
      </span>,
    );
    i = end;
  }
  if (i < message.length) out.push(message.slice(i));
  return out;
}

/**
 * The table's chat. Typing `@` offers everyone at the table by name: a
 * mention is picked out in the message for all to see, and the player it
 * names is alerted wherever they're looking (see Table.tsx). Tapping a
 * message's author starts a mention of them.
 */
export function ChatPanel({
  messages,
  onSend,
  people = [],
  myUserId = null,
  myName = null,
}: {
  messages: ChatMessageRecord[];
  onSend: (message: string) => void;
  /** Everyone who can be mentioned: the names of the players seated at the table. */
  people?: readonly string[];
  myUserId?: string | null;
  myName?: string | null;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The newest message stays in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const partial = mentionBeingTyped(draft);
  const others = people.filter((n) => myName === null || n.toLowerCase() !== myName.toLowerCase());
  const suggestions = partial === null ? [] : others.filter((n) => n.toLowerCase().startsWith(partial.toLowerCase()) && n.toLowerCase() !== partial.toLowerCase()).slice(0, 6);
  const choice = Math.min(picked, Math.max(0, suggestions.length - 1));

  const mention = (name: string): void => {
    setDraft((d) => {
      const at = mentionBeingTyped(d) === null ? -1 : d.lastIndexOf('@');
      const before = at >= 0 ? d.slice(0, at) : d.length > 0 && !/\s$/.test(d) ? `${d} ` : d;
      return (name ? `${before}@${name} ` : `${before}@`).slice(0, 500);
    });
    setPicked(0);
    inputRef.current?.focus();
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft('');
  };

  return (
    <div className="chat-panel">
      <div className="chat-messages" ref={listRef}>
        {messages.map((m) => (
          // The dealer's own lines (a split pot, in plain words) are local to each viewer — see Table.tsx.
          <div
            key={m.id}
            className={`chat-message${m.id.startsWith('dealer-') ? ' chat-message--dealer' : ''}${myUserId !== null && m.mentions?.includes(myUserId) ? ' chat-message--mentions-me' : ''}`}
          >
            {m.displayName && m.userId && m.userId !== myUserId && people.includes(m.displayName) ? (
              <button type="button" className="chat-author chat-author--tap" title={`Mention ${m.displayName}`} onClick={() => mention(m.displayName!)}>
                {m.displayName}:
              </button>
            ) : (
              <span className="chat-author">{m.displayName ?? 'System'}:</span>
            )}{' '}
            {withMentions(m.message, people, myName)}
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="chat-form">
        {suggestions.length > 0 && (
          <div className="chat-mention-list" role="listbox" aria-label="Mention a player">
            {suggestions.map((name, i) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={i === choice}
                className={`chat-mention-option${i === choice ? ' chat-mention-option--on' : ''}`}
                // Before the input loses focus (a phone would close its keyboard).
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => mention(name)}
              >
                @{name}
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={500}
          placeholder={others.length > 0 ? 'Say something… @ to mention' : 'Say something...'}
          aria-label="Chat message"
          onChange={(e) => {
            setDraft(e.target.value);
            setPicked(0);
          }}
          onKeyDown={(e) => {
            if (suggestions.length === 0) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setPicked((choice + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              mention(suggestions[choice]!);
            }
          }}
        />
        {others.length > 0 && (
          <button type="button" className="chat-mention-button" aria-label="Mention a player" title="Mention a player" onClick={() => mention('')}>
            @
          </button>
        )}
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

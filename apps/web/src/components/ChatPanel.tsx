import { useState } from 'react';
import type { ChatMessageRecord } from '../types.js';

export function ChatPanel({ messages, onSend }: { messages: ChatMessageRecord[]; onSend: (message: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('');

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft('');
  };

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {messages.map((m) => (
          // The dealer's own lines (a split pot, in plain words) are local to each viewer — see Table.tsx.
          <div key={m.id} className={`chat-message${m.id.startsWith('dealer-') ? ' chat-message--dealer' : ''}`}>
            <span className="chat-author">{m.displayName ?? 'System'}:</span> {m.message}
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="chat-form">
        <input
          type="text"
          value={draft}
          maxLength={500}
          placeholder="Say something..."
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

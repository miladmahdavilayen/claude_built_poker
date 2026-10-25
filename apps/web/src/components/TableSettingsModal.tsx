import { useEffect, useState } from 'react';
import { adminGetTableSettings, adminUpdateTableSettings } from '../api.js';
import { diffSettings, formFromSettings, TableSettingsFields, type SettingsForm } from './TableSettingsForm.js';

/**
 * The owner's settings editor for a table, opened from the lobby by holding
 * (or right-clicking) its card — public or private, without sitting down at
 * it. The same settings and rules as the owner menu at the table: blinds,
 * ante and straddle changed mid-hand switch over when that hand ends;
 * everything else applies at once, and everyone at the table sees it.
 */
export function TableSettingsModal({
  tableId,
  tableName,
  accessToken,
  onClose,
  onSaved,
}: {
  tableId: string;
  tableName: string;
  accessToken: string;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [base, setBase] = useState<SettingsForm | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [inHand, setInHand] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    adminGetTableSettings(tableId, accessToken)
      .then((r) => {
        const f = formFromSettings(r.name, r.settings);
        setBase(f);
        setForm(f);
        setInHand(r.inHand);
        setInviteCode(r.inviteCode);
      })
      .catch((err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Couldn’t load this table’s settings.' }));
  }, [tableId, accessToken]);

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]): void => {
    setMessage(null);
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const patch = form && base ? diffSettings(form, base) : {};
  const hasChanges = typeof patch === 'string' || Object.keys(patch).length > 0;

  // A private table's live invite link — the same one the owner menu at the
  // table shows — so the owner can grab it here and share it.
  const link = inviteCode ? `${window.location.origin}/table/${tableId}?code=${inviteCode}` : null;
  const copyLink = (): void => {
    if (!link) return;
    void navigator.clipboard.writeText(link).then(() => setCopied(true));
  };

  const save = (): void => {
    if (typeof patch === 'string') {
      setMessage({ ok: false, text: patch });
      return;
    }
    setBusy(true);
    adminUpdateTableSettings(tableId, patch, accessToken)
      .then((r) => {
        const f = formFromSettings(r.name, r.settings);
        setBase(f);
        setForm(f);
        setInviteCode(r.inviteCode);
        setMessage({ ok: true, text: r.deferred ? 'Saved — blinds/ante/straddle switch over when the hand in progress ends.' : 'Saved.' });
        onSaved();
      })
      .catch((err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Couldn’t save.' }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal table-settings-modal" role="dialog" aria-label="Table settings" onClick={(e) => e.stopPropagation()}>
        <h3>Table settings — {base?.name ?? tableName}</h3>
        {link && (
          <div className="table-settings-link">
            <p className="owner-menu-note">
              {form?.openSeatStack != null
                ? 'Open invite link — anyone with it can pick a free seat or join the waitlist:'
                : 'Invite link — only people with it can join:'}
            </p>
            <div className="table-settings-link-row">
              <input
                type="text"
                className="assign-link-input"
                readOnly
                aria-label="Table invite link"
                value={link}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" onClick={copyLink}>
                {copied ? 'Copied ✓' : 'Copy link'}
              </button>
            </div>
          </div>
        )}
        {inHand && <p className="owner-menu-note">A hand is in progress: blinds, ante and straddle switch over when it ends. Everything else applies right away.</p>}
        {form ? <TableSettingsFields form={form} set={set} /> : !message && <p className="muted">Loading…</p>}
        {message && <div className={message.ok ? 'owner-menu-ok' : 'error-banner'}>{message.text}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={!form || !hasChanges || busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

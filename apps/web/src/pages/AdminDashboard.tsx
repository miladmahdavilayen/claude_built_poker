import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api.js';
import type { AdminUserDetailDto, AdminUserDto, GameReportSummaryDto, LedgerEntryDto, SignupKeyDto } from '../api.js';
import { useAuth } from '../AuthContext.js';
import { MAX_BALANCE_CENTS } from '@pokerclause/shared/money';
import { formatChips } from '../chips.js';
import { ReportDownloads } from '../components/ReportDownloads.js';
import { MoneyInput } from '../components/MoneyInput.js';

const REASON_LABEL: Record<LedgerEntryDto['reason'], string> = {
  buy_in: 'Bought in',
  cash_out: 'Cashed out',
  pot_win: 'Hand result',
  rake: 'Rake',
  admin_adjust: 'Admin adjustment',
  welcome_bonus: 'Welcome bonus',
};

/**
 * Admin-only: look up and manage every human account on this deployment —
 * see and edit their balance, rename them, or delete their account, one
 * at a time (swipe a row left to reveal a delete action) or several at
 * once (select multiple, or "select all", then bulk-delete). Every
 * account listed here is a real, signed-in (Google) human — a guest is
 * never persisted at all anymore (see HybridStore), so there's nothing
 * of theirs for this page to ever show or manage in the first place.
 */
/**
 * The owner's own balance, front and centre: add to it, or set it to an
 * exact amount (up to MAX_BALANCE_CENTS). Same ledgered adjustments as the
 * per-player panel below, just without having to find your own row.
 */
function MyBalanceCard({ balance, onChanged }: { balance: number | null; onChanged: () => void }): React.JSX.Element {
  const { user, accessToken } = useAuth();
  const [amount, setAmount] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = (mode: 'add' | 'set'): void => {
    if (!user || !accessToken || amount === '') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const request =
      mode === 'add'
        ? api.adminAdjustChips(user.id, amount, 'Owner top-up', accessToken)
        : api.adminSetChips(user.id, amount, 'Owner set balance', accessToken);
    request
      .then((res) => {
        setNotice(`Your balance is now ${formatChips(res.chips)}.`);
        setAmount('');
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to update your balance.'))
      .finally(() => setBusy(false));
  };

  return (
    <section className="admin-my-balance" data-testid="admin-my-balance">
      <div className="admin-my-balance-header">
        <h2 className="admin-section-title">My balance</h2>
        <span className="admin-my-balance-value">{balance === null ? '…' : formatChips(balance)}</span>
      </div>
      <label>
        Amount in $
        <MoneyInput cents={amount} onChange={setAmount} minCents={0} maxCents={MAX_BALANCE_CENTS} disabled={busy} placeholder="e.g. 5000" />
      </label>
      <div className="admin-my-balance-actions">
        <button type="button" disabled={busy || amount === '' || amount <= 0} onClick={() => run('add')}>
          Add to my balance
        </button>
        <button type="button" disabled={busy || amount === ''} onClick={() => run('set')}>
          Set my balance to this
        </button>
      </div>
      <p className="profile-hint">Up to {formatChips(MAX_BALANCE_CENTS)}. Every change is recorded in your activity.</p>
      {notice && <p className="admin-my-balance-notice">{notice}</p>}
      {error && <div className="error-banner">{error}</div>}
    </section>
  );
}

export function AdminDashboardPage(): React.JSX.Element {
  const { accessToken, user: me } = useAuth();
  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = (): void => {
    if (!accessToken) return;
    api
      .adminListUsers(accessToken)
      .then((res) => setUsers(res.users))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load users.'));
  };

  useEffect(refresh, [accessToken]);

  const filtered = users.filter((u) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return u.displayName.toLowerCase().includes(q) || (u.email?.toLowerCase().includes(q) ?? false);
  });
  // The admin's own row never gets a checkbox (it can't be deleted — see
  // the server's own CANNOT_DELETE_ADMIN guard, mirrored here so "select
  // all" never includes an id that would just get silently skipped).
  const selectableIds = filtered.filter((u) => u.role !== 'admin').map((u) => u.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => checkedIds.has(id));

  const toggleChecked = (id: string): void => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = (): void => {
    setCheckedIds(allSelected ? new Set() : new Set(selectableIds));
  };

  const handleRowDeleted = (id: string): void => {
    if (selectedId === id) setSelectedId(null);
    setCheckedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    refresh();
  };

  const bulkDelete = (): void => {
    if (!accessToken || checkedIds.size === 0) return;
    setBulkBusy(true);
    setError(null);
    api
      .adminBulkDeleteUsers([...checkedIds], accessToken)
      .then(() => {
        if (selectedId && checkedIds.has(selectedId)) setSelectedId(null);
        setCheckedIds(new Set());
        refresh();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to delete the selected accounts.'))
      .finally(() => setBulkBusy(false));
  };

  return (
    <div className="lobby-page">
      <header className="lobby-header">
        <h1 className="lobby-brand">Admin dashboard</h1>
        <Link to="/lobby" className="btn-ghost lobby-link-button">
          &larr; Lobby
        </Link>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <MyBalanceCard balance={users.find((u) => u.id === me?.id)?.chips ?? null} onChanged={refresh} />

      {accessToken && <AccessKeysPanel accessToken={accessToken} />}

      {accessToken && <GameReportsPanel accessToken={accessToken} />}

      <h2 className="admin-section-title">Players</h2>
      <input
        className="admin-search"
        placeholder="Search by name or email..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="admin-list-toolbar">
        <label className="admin-select-all">
          <input type="checkbox" checked={allSelected} disabled={selectableIds.length === 0} onChange={toggleSelectAll} />
          Select all
        </label>
        {checkedIds.size > 0 && (
          <button type="button" className="btn-owner-action btn-owner-danger" disabled={bulkBusy} onClick={bulkDelete}>
            {bulkBusy ? 'Deleting…' : `Delete ${String(checkedIds.size)} selected`}
          </button>
        )}
      </div>

      <div className="admin-layout">
        <div className="admin-user-list">
          {filtered.map((u) => (
            <AdminUserRow
              key={u.id}
              user={u}
              isActive={selectedId === u.id}
              isChecked={checkedIds.has(u.id)}
              onOpen={() => setSelectedId(u.id)}
              onToggleChecked={() => toggleChecked(u.id)}
              onDeleted={() => handleRowDeleted(u.id)}
            />
          ))}
          {filtered.length === 0 && <p className="profile-hint">No users match.</p>}
        </div>

        {selectedId && <AdminUserDetail userId={selectedId} onClose={() => setSelectedId(null)} onChanged={refresh} />}
      </div>
    </div>
  );
}

const SWIPE_REVEAL_PX = 84;
const SWIPE_OPEN_THRESHOLD_PX = 40;
const TAP_MAX_MOVEMENT_PX = 8;

/**
 * One row: a leading checkbox (untouched by the swipe gesture below it),
 * and a swipeable content area — dragging it left reveals a red "Delete"
 * action underneath, the same convention as a native mobile mail app's
 * swipe-to-delete. Tapping the revealed action deletes immediately (the
 * swipe itself is already the deliberate, hard-to-do-by-accident
 * confirmation — the same convention those apps rely on), and admin's
 * own row never becomes swipeable at all (it can't be deleted regardless).
 */
function AdminUserRow({
  user,
  isActive,
  isChecked,
  onOpen,
  onToggleChecked,
  onDeleted,
}: {
  user: AdminUserDto;
  isActive: boolean;
  isChecked: boolean;
  onOpen: () => void;
  onToggleChecked: () => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const { accessToken } = useAuth();
  const [open, setOpen] = useState(false); // fully swiped open, Delete action revealed
  const [dragOffset, setDragOffset] = useState<number | null>(null); // non-null only while an active drag is in progress
  const [deleting, setDeleting] = useState(false);
  const dragStartRef = useRef<{ x: number; base: number } | null>(null);

  const canDelete = user.role !== 'admin';

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!canDelete) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { x: e.clientX, base: open ? -SWIPE_REVEAL_PX : 0 };
    setDragOffset(open ? -SWIPE_REVEAL_PX : 0);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStartRef.current) return;
    const delta = e.clientX - dragStartRef.current.x;
    setDragOffset(Math.min(0, Math.max(dragStartRef.current.base + delta, -SWIPE_REVEAL_PX)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStartRef.current) return;
    const totalDelta = e.clientX - dragStartRef.current.x;
    const wasOpen = open;
    dragStartRef.current = null;
    const finalOffset = dragOffset ?? 0;
    setDragOffset(null);

    if (Math.abs(totalDelta) < TAP_MAX_MOVEMENT_PX) {
      // A plain tap, not a drag: closes an already-open row, or opens the detail view.
      if (wasOpen) setOpen(false);
      else onOpen();
      return;
    }
    setOpen(finalOffset <= -SWIPE_OPEN_THRESHOLD_PX);
  };

  const handleDelete = (): void => {
    if (!accessToken || deleting) return;
    setDeleting(true);
    api
      .adminDeleteUser(user.id, accessToken)
      .then(() => onDeleted())
      .catch(() => setDeleting(false));
  };

  const offset = dragOffset ?? (open ? -SWIPE_REVEAL_PX : 0);

  return (
    <div className="admin-user-row-wrap">
      {canDelete && (
        <button type="button" className="admin-user-row-delete-action" onClick={handleDelete} disabled={deleting} aria-label={`Delete ${user.displayName}`}>
          {deleting ? '…' : 'Delete'}
        </button>
      )}
      <div
        className={`admin-user-row ${isActive ? 'admin-user-row-active' : ''} ${dragOffset !== null ? 'admin-user-row-dragging' : ''}`}
        style={{ transform: `translateX(${String(offset)}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {canDelete ? (
          <input
            type="checkbox"
            className="admin-user-row-checkbox"
            checked={isChecked}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={onToggleChecked}
          />
        ) : (
          <span className="admin-user-row-checkbox" />
        )}
        <span className="admin-user-row-name">
          {user.displayName}
          {user.role === 'admin' && <span className="seat-tag seat-tag-allin">admin</span>}
        </span>
        <span className="admin-user-row-chips">{formatChips(user.chips)}</span>
      </div>
    </div>
  );
}

function AdminUserDetail({ userId, onClose, onChanged }: { userId: string; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const { accessToken } = useAuth();
  const [detail, setDetail] = useState<AdminUserDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [chipAmount, setChipAmount] = useState(0);
  const [chipReason, setChipReason] = useState('Buy-in');
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const load = (): void => {
    if (!accessToken) return;
    setError(null);
    api
      .adminGetUser(userId, accessToken)
      .then((res) => {
        setDetail(res);
        setDisplayName(res.displayName);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load this user.'));
  };

  useEffect(load, [userId, accessToken]);

  if (!detail) {
    return (
      <div className="admin-user-detail">
        {error ? <div className="error-banner">{error}</div> : <p className="profile-hint">Loading...</p>}
      </div>
    );
  }

  const submitRename = (): void => {
    if (!accessToken || !displayName.trim()) return;
    setBusy(true);
    api
      .adminUpdateUser(userId, displayName.trim(), accessToken)
      .then(() => {
        load();
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to rename.'))
      .finally(() => setBusy(false));
  };

  const submitChips = (): void => {
    if (!accessToken || chipAmount === 0) return;
    setBusy(true);
    api
      .adminAdjustChips(userId, chipAmount, chipReason || 'Admin adjustment', accessToken)
      .then(() => {
        setChipAmount(0);
        load();
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to adjust chips.'))
      .finally(() => setBusy(false));
  };

  const submitSetChips = (): void => {
    if (!accessToken || chipAmount < 0) return;
    setBusy(true);
    api
      .adminSetChips(userId, chipAmount, chipReason || 'Admin set balance', accessToken)
      .then(() => {
        setChipAmount(0);
        load();
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to set the balance.'))
      .finally(() => setBusy(false));
  };

  const submitDelete = (): void => {
    if (!accessToken) return;
    setBusy(true);
    api
      .adminDeleteUser(userId, accessToken)
      .then(() => {
        onChanged();
        onClose();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to delete this account.'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="admin-user-detail">
      <div className="admin-user-detail-header">
        <h3>{detail.displayName}</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="profile-summary">
        <div className="profile-stat-card">
          <span className="stat-label">Account</span>
          <span className="stat-value">{detail.isGuest ? 'Guest' : detail.hasGoogle ? 'Google' : 'Password'}</span>
        </div>
        <div className="profile-stat-card">
          <span className="stat-label">Balance</span>
          <span className="stat-value">{formatChips(detail.chips)}</span>
        </div>
        {detail.hasGoogle && (
          <div className="profile-stat-card">
            <span className="stat-label">Waiver</span>
            <span className="stat-value">
              {detail.waiver ? `Agreed (${detail.waiver.initials}) · ${new Date(detail.waiver.acceptedAt).toLocaleDateString()}` : 'Not agreed yet'}
            </span>
          </div>
        )}
        <div className="profile-stat-card">
          <span className="stat-label">Net from playing</span>
          <span className={`stat-value ${detail.netPlayResult >= 0 ? 'profile-stat-positive' : 'profile-stat-negative'}`}>
            {detail.netPlayResult >= 0 ? '+' : ''}
            {formatChips(detail.netPlayResult)}
          </span>
        </div>
      </div>

      <label>
        Display name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={24} disabled={busy} />
      </label>
      <button type="button" disabled={busy || !displayName.trim() || displayName === detail.displayName} onClick={submitRename}>
        Save name
      </button>

      <label>
        Amount in $ — add it (negative to take away), or set the balance to exactly this
        <MoneyInput cents={chipAmount} onChange={(c) => setChipAmount(c === '' ? 0 : c)} disabled={busy} />
      </label>
      <label>
        Reason
        <input value={chipReason} onChange={(e) => setChipReason(e.target.value)} disabled={busy} />
      </label>
      <div className="admin-my-balance-actions">
        <button type="button" disabled={busy || chipAmount === 0} onClick={submitChips}>
          Add to balance
        </button>
        <button type="button" disabled={busy || chipAmount < 0} onClick={submitSetChips}>
          Set balance to this
        </button>
      </div>

      <h4>Recent activity</h4>
      {detail.recentEntries.length === 0 && <p className="profile-hint">Nothing yet.</p>}
      {detail.recentEntries.length > 0 && (
        <div className="profile-history">
          {detail.recentEntries.map((entry) => (
            <div className="profile-history-row" key={entry.id}>
              <span>{REASON_LABEL[entry.reason]}</span>
              <span className={entry.amount >= 0 ? 'profile-stat-positive' : 'profile-stat-negative'}>
                {entry.amount >= 0 ? '+' : ''}
                {formatChips(entry.amount)}
              </span>
              <span className="profile-history-date">{new Date(entry.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {detail.role !== 'admin' && (
        <div className="profile-danger-zone">
          {!deleteConfirm ? (
            <button type="button" className="btn-owner-action btn-owner-danger" onClick={() => setDeleteConfirm(true)}>
              Delete this account
            </button>
          ) : (
            <>
              <p className="profile-hint">Permanently deletes {detail.displayName}&rsquo;s account. This cannot be undone.</p>
              <div className="modal-actions">
                <button type="button" onClick={() => setDeleteConfirm(false)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="btn-owner-action btn-owner-danger" disabled={busy} onClick={submitDelete}>
                  Confirm delete
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type ReportSort = 'newest' | 'oldest' | 'table';

/** "+$40", "-$12.50", "$0" — a player's result, signed. */
const KEY_STATUS_LABEL: Record<SignupKeyDto['status'], string> = {
  active: 'Active',
  used: 'Used',
  revoked: 'Revoked',
  expired: 'Expired',
};

/**
 * One-time access keys for new players (see apps/server's signupKeys.ts):
 * generate one per person, send it to them, and it registers exactly one
 * Google account — optionally only theirs, if you give their email. The
 * key is shown here once, right after generating it; only its last four
 * characters are kept for telling keys apart.
 */
function AccessKeysPanel({ accessToken }: { accessToken: string }): React.JSX.Element {
  const [keys, setKeys] = useState<SignupKeyDto[]>([]);
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [days, setDays] = useState(7);
  const [fresh, setFresh] = useState<{ key: string; label: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState<'key' | 'message' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    api
      .adminListSignupKeys(accessToken)
      .then((res) => setKeys(res.keys))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load access keys.'));
  };
  useEffect(refresh, [accessToken]);

  const generate = (e: React.FormEvent): void => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(null);
    api
      .adminCreateSignupKey({ label: label.trim(), expiresInDays: days, ...(email.trim() ? { email: email.trim() } : {}) }, accessToken)
      .then((res) => {
        setFresh({ key: res.key, label: label.trim(), expiresAt: res.expiresAt });
        setLabel('');
        setEmail('');
        refresh();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to generate a key.'))
      .finally(() => setBusy(false));
  };

  const revoke = (id: string): void => {
    api
      .adminRevokeSignupKey(id, accessToken)
      .then(refresh)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to revoke the key.'));
  };

  const copy = (what: 'key' | 'message', text: string): void => {
    void navigator.clipboard.writeText(text).then(() => setCopied(what));
  };

  const message = fresh
    ? `You're invited to PokerClause! Go to ${window.location.origin}, choose "Have an access key?", and enter this key, then sign up with Google:

${fresh.key}

It works once and expires ${new Date(fresh.expiresAt).toLocaleDateString()}.`
    : '';

  return (
    <section className="admin-keys" data-testid="admin-access-keys">
      <h2 className="admin-section-title">Access keys</h2>
      <p className="profile-hint">One key per new player. Each works once, to register one Google account, and expires if unused.</p>
      <form className="admin-keys-form" onSubmit={generate}>
        <label>
          Who it&rsquo;s for
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="e.g. Dave from work" required />
        </label>
        <label>
          Their Google email (optional)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Only this email can use the key" />
        </label>
        <label>
          Expires in
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d} {d === 1 ? 'day' : 'days'}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary" disabled={busy || !label.trim()}>
          {busy ? 'Generating…' : 'Generate key'}
        </button>
      </form>
      {error && <div className="error-banner">{error}</div>}

      {fresh && (
        <div className="admin-key-fresh" data-testid="fresh-access-key">
          <span className="stat-label">Key for {fresh.label} — copy it now, it won&rsquo;t be shown again</span>
          <code className="admin-key-value">{fresh.key}</code>
          <div className="admin-my-balance-actions">
            <button type="button" onClick={() => copy('key', fresh.key)}>
              {copied === 'key' ? 'Copied ✓' : 'Copy key'}
            </button>
            <button type="button" onClick={() => copy('message', message)}>
              {copied === 'message' ? 'Copied ✓' : 'Copy invite message'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setFresh(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="admin-key-list">
          {keys.map((k) => (
            <li key={k.id} className="admin-key-row" data-testid={`access-key-${k.id}`}>
              <div className="admin-key-info">
                <span className="admin-key-label">
                  {k.label} <span className="admin-key-hint">…{k.hint}</span>
                </span>
                <span className="admin-report-meta">
                  {k.email ? `${k.email} · ` : ''}
                  {k.status === 'used'
                    ? `registered ${k.usedByName ?? '(deleted account)'} · ${new Date(k.usedAt!).toLocaleDateString()}`
                    : k.status === 'revoked'
                      ? 'revoked — never used'
                      : `${k.status === 'active' ? 'expires' : 'expired'} ${new Date(k.expiresAt).toLocaleDateString()}`}
                </span>
              </div>
              <span className={`admin-key-status admin-key-status-${k.status}`}>{KEY_STATUS_LABEL[k.status]}</span>
              {k.status === 'active' && (
                <button type="button" className="btn-owner-danger btn-owner-action" onClick={() => revoke(k.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function signedMoney(cents: number): string {
  return cents > 0 ? `+${formatChips(cents)}` : formatChips(cents);
}

/**
 * Every game's books — live games (still being played) and finished ones,
 * kept permanently — grouped by the day they started, each titled by its
 * table's name, with the headline numbers and standings at a glance (from
 * the structured game_reports / game_report_players columns, no YAML
 * parsing). The same YAML/PDF downloads as the table's own owner menu;
 * this is where a finished game's report lives once its table is gone.
 * See apps/server/src/game/gameBook.ts.
 */
function GameReportsPanel({ accessToken }: { accessToken: string }): React.JSX.Element {
  const [reports, setReports] = useState<GameReportSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<ReportSort>('newest');
  const [search, setSearch] = useState('');

  const refresh = (): void => {
    api
      .adminListGameReports(accessToken)
      .then((res) => setReports(res.reports))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load game reports.'));
  };
  useEffect(refresh, [accessToken]);

  const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const query = search.trim().toLowerCase();
  const shown = (reports ?? [])
    .filter((r) => !query || r.tableName.toLowerCase().includes(query) || r.summary?.players.some((p) => p.playerName.toLowerCase().includes(query)))
    .sort((a, b) => {
      const byStart = new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
      if (sort === 'oldest') return -byStart;
      if (sort === 'table') return a.tableName.localeCompare(b.tableName) || byStart;
      return byStart;
    });
  // Group under a heading per start day — or per table, when sorted by table.
  const groups: { heading: string; reports: GameReportSummaryDto[] }[] = [];
  for (const r of shown) {
    const heading = sort === 'table' ? r.tableName : day(r.startedAt);
    const last = groups[groups.length - 1];
    if (last?.heading === heading) last.reports.push(r);
    else groups.push({ heading, reports: [r] });
  }

  return (
    <section className="admin-reports">
      <div className="admin-reports-header">
        <h2 className="admin-section-title">Game reports</h2>
        <button type="button" className="btn-secondary" onClick={refresh}>
          Refresh
        </button>
      </div>
      {reports && reports.length > 0 && (
        <div className="admin-reports-controls">
          <input
            type="search"
            className="admin-reports-search"
            placeholder="Search table or player"
            aria-label="Search game reports by table or player"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select aria-label="Sort game reports" value={sort} onChange={(e) => setSort(e.target.value as ReportSort)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="table">By table name</option>
          </select>
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {reports === null && !error && <p className="profile-hint">Loading…</p>}
      {reports?.length === 0 && <p className="profile-hint">No games played yet — a report appears here after a table&rsquo;s first hand.</p>}
      {reports && reports.length > 0 && shown.length === 0 && <p className="profile-hint">No game matches &ldquo;{search}&rdquo;.</p>}
      <div className="admin-reports-list">
        {groups.map((g) => (
          <div key={g.heading} className="admin-reports-group">
            <h3 className="admin-reports-day">{g.heading}</h3>
            <ul>
              {g.reports.map((r) => {
                const s = r.summary;
                const humans = s?.players.filter((p) => p.playerType !== 'bot') ?? [];
                return (
                  <li key={r.id} className="admin-report-row" data-testid={`report-${r.id}`}>
                    <div className="admin-report-info">
                      <span className="admin-report-name">
                        {r.tableName}
                        {s && s.gameNumber > 1 ? <span className="admin-report-game"> · game {s.gameNumber}</span> : null}
                      </span>
                      <span className={`seat-tag ${r.status === 'live' ? 'seat-tag-pending' : ''}`}>{r.status === 'live' ? 'live' : 'final'}</span>
                      {s && !s.booksBalance && <span className="seat-tag admin-report-unbalanced">books don&rsquo;t balance</span>}
                      <span className="admin-report-meta">
                        {sort === 'table' ? `${day(r.startedAt)}, ` : ''}
                        {time(r.startedAt)} – {r.status === 'live' ? `now (updated ${time(r.updatedAt)})` : time(r.endedAt ?? r.updatedAt)}
                        {s?.stakes ? ` · ${s.stakes} blinds` : ''} · {r.handsPlayed} hand{r.handsPlayed === 1 ? '' : 's'}
                        {s ? ` · ${String(s.playerCount)} player${s.playerCount === 1 ? '' : 's'} · ${formatChips(s.totalBoughtIn)} bought in` : ''}
                      </span>
                      {humans.length > 0 && (
                        <span className="admin-report-standings">
                          {humans.map((p) => (
                            <span key={p.rank} className={p.net > 0 ? 'net-up' : p.net < 0 ? 'net-down' : 'net-even'}>
                              {p.playerName} {signedMoney(p.net)}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <ReportDownloads path={`/admin/reports/${r.id}`} accessToken={accessToken} />
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

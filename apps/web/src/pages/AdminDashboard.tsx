import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api.js';
import type { AdminUserDetailDto, AdminUserDto, LedgerEntryDto } from '../api.js';
import { useAuth } from '../AuthContext.js';
import { formatChips } from '../chips.js';

const REASON_LABEL: Record<LedgerEntryDto['reason'], string> = {
  buy_in: 'Bought in',
  cash_out: 'Cashed out',
  pot_win: 'Hand result',
  rake: 'Rake',
  admin_adjust: 'Admin adjustment',
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
export function AdminDashboardPage(): React.JSX.Element {
  const { accessToken } = useAuth();
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
        Adjust balance (a buy-in, rebuy, or correction — positive or negative)
        <input type="number" value={chipAmount} onChange={(e) => setChipAmount(Number(e.target.value))} disabled={busy} />
      </label>
      <label>
        Reason
        <input value={chipReason} onChange={(e) => setChipReason(e.target.value)} disabled={busy} />
      </label>
      <button type="button" disabled={busy || chipAmount === 0} onClick={submitChips}>
        Apply
      </button>

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

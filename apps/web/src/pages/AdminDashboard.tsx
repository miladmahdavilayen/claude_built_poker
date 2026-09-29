import { useEffect, useState } from 'react';
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
 * see and edit their balance, rename them, or delete their account
 * outright. The list/detail/chip-adjust/patch/delete endpoints this reads
 * from (apps/server/src/http/routes/admin.ts) already existed or were
 * added alongside this page; this is the first UI to actually use them.
 */
export function AdminDashboardPage(): React.JSX.Element {
  const { accessToken } = useAuth();
  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

      <div className="admin-layout">
        <div className="admin-user-list">
          {filtered.map((u) => (
            <button
              type="button"
              key={u.id}
              className={`admin-user-row ${selectedId === u.id ? 'admin-user-row-active' : ''}`}
              onClick={() => setSelectedId(u.id)}
            >
              <span className="admin-user-row-name">
                {u.displayName}
                {u.role === 'admin' && <span className="seat-tag seat-tag-allin">admin</span>}
                {u.isGuest && <span className="seat-tag">guest</span>}
              </span>
              <span className="admin-user-row-chips">{formatChips(u.chips)}</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="profile-hint">No users match.</p>}
        </div>

        {selectedId && <AdminUserDetail userId={selectedId} onClose={() => setSelectedId(null)} onChanged={refresh} />}
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

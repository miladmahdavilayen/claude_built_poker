import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../api.js';
import type { LedgerEntryDto, MySummaryDto } from '../api.js';
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
 * A signed-in (non-guest) human's own balance, net result from actually
 * playing hands (separate from admin-granted buy-ins — see
 * `ledgerPlayNetForUser` server-side), a recent transaction history, and
 * the one place they can permanently delete their own account. Guests
 * never reach this page (App.tsx redirects them to the lobby) — they
 * already lose everything the moment they leave/reset/close a table, so
 * there's nothing durable here for them to look at.
 */
export function ProfilePage(): React.JSX.Element {
  const { user, deleteAccount, accessToken } = useAuth();
  const [summary, setSummary] = useState<MySummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!accessToken) return;
    api
      .getMySummary(accessToken)
      .then(setSummary)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load your profile.'));
  }, [accessToken]);

  if (!user) return <div className="page-centered">Loading...</div>;

  const confirmationPhrase = 'delete my account';
  const canConfirmDelete = deleteConfirmText.trim().toLowerCase() === confirmationPhrase;

  const handleDelete = (): void => {
    setDeleteError(null);
    setDeleting(true);
    deleteAccount()
      .then(() => void navigate('/login'))
      .catch((err: unknown) => {
        setDeleteError(err instanceof Error ? err.message : 'Failed to delete your account.');
        setDeleting(false);
      });
  };

  return (
    <div className="lobby-page">
      <header className="lobby-header">
        <h1 className="lobby-brand">My profile</h1>
        <Link to="/lobby" className="btn-ghost lobby-link-button">
          &larr; Lobby
        </Link>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="profile-summary">
        <div className="profile-stat-card">
          <span className="stat-label">Display name</span>
          <span className="stat-value">{user.displayName}</span>
        </div>
        <div className="profile-stat-card">
          <span className="stat-label">Balance</span>
          <span className="stat-value">{formatChips(summary?.balance ?? user.chips)}</span>
        </div>
        <div className="profile-stat-card">
          <span className="stat-label">Net result from playing</span>
          <span className={`stat-value ${(summary?.netPlayResult ?? 0) >= 0 ? 'profile-stat-positive' : 'profile-stat-negative'}`}>
            {summary ? `${summary.netPlayResult >= 0 ? '+' : ''}${formatChips(summary.netPlayResult)}` : '—'}
          </span>
        </div>
      </div>
      <p className="profile-hint">
        Only the admin can add to your balance (a buy-in or a rebuy) — ask them for chips before sitting down at a table.
      </p>

      <h3>Recent activity</h3>
      {summary && summary.recentEntries.length === 0 && <p className="profile-hint">Nothing yet — this fills in once you play a hand.</p>}
      {summary && summary.recentEntries.length > 0 && (
        <div className="profile-history">
          {summary.recentEntries.map((entry) => (
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

      {/* The admin/owner account can't delete itself this way — see /users/me's own CANNOT_DELETE_ADMIN guard — so this is never offered to it in the first place. */}
      {user.role !== 'admin' && (
        <div className="profile-danger-zone">
          <h3>Delete account</h3>
          <p className="profile-hint">Permanently deletes your account and balance. Your past hand history stays on record, anonymized.</p>
          <button type="button" className="btn-owner-danger btn-owner-action" onClick={() => setShowDeleteConfirm(true)}>
            Delete my account
          </button>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="modal-backdrop" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete your account?</h3>
            <p>This cannot be undone. You will lose your balance and be signed out immediately.</p>
            {deleteError && <div className="error-banner">{deleteError}</div>}
            <label>
              Type &ldquo;{confirmationPhrase}&rdquo; to confirm
              <input value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} disabled={deleting} />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>
                Cancel
              </button>
              <button type="button" className="btn-owner-action btn-owner-danger" disabled={!canConfirmDelete || deleting} onClick={handleDelete}>
                {deleting ? 'Deleting…' : 'Permanently delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

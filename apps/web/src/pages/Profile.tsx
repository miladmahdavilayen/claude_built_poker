import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../api.js';
import type { MyProfileDto } from '../api.js';
import { useAuth } from '../AuthContext.js';

const SIGN_IN_METHOD_LABEL: Record<MyProfileDto['signInMethod'], string> = {
  google: 'Google',
  guest: 'Guest',
  password: 'Email and password',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * A signed-in (non-guest) human's own account: exactly what they
 * registered with, and the one place they can permanently delete it.
 * Nothing else — balance lives in the lobby header. Guests never reach
 * this page (App.tsx redirects them to the lobby).
 */
export function ProfilePage(): React.JSX.Element {
  const { user, deleteAccount, accessToken } = useAuth();
  const [profile, setProfile] = useState<MyProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!accessToken) return;
    api
      .getMyProfile(accessToken)
      .then(setProfile)
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

      {profile && (
        <section className="profile-card">
          {profile.avatarUrl && <img className="profile-avatar" src={profile.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <dl className="profile-fields">
            <dt>Name</dt>
            <dd>{profile.displayName}</dd>
            <dt>Email</dt>
            <dd>{profile.email ?? '—'}</dd>
            <dt>Signed up with</dt>
            <dd>{SIGN_IN_METHOD_LABEL[profile.signInMethod]}</dd>
            <dt>Member since</dt>
            <dd>{formatDate(profile.createdAt)}</dd>
          </dl>
        </section>
      )}

      {/* The admin/owner account can't delete itself this way — see /users/me's own CANNOT_DELETE_ADMIN guard — so this is never offered to it in the first place. */}
      {user.role !== 'admin' && (
        <div className="profile-danger-zone">
          <h3>Delete account</h3>
          <p className="profile-hint">
            Permanently deletes your account. Your balance is kept: sign up again later with the same Google account and it&rsquo;ll be waiting for you
            (there&rsquo;s no second welcome bonus).
          </p>
          <button type="button" className="btn-owner-danger btn-owner-action" onClick={() => setShowDeleteConfirm(true)}>
            Delete my account
          </button>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="modal-backdrop" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete your account?</h3>
            <p>
              This cannot be undone, and you&rsquo;ll be signed out immediately. If you sign up again with the same Google account (you&rsquo;ll need a new
              access key), you&rsquo;ll start with the balance you have now.
            </p>
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

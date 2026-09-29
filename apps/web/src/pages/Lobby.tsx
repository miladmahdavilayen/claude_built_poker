import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api.js';
import type { TableSummaryDto } from '../api.js';
import { useAuth } from '../AuthContext.js';
import { formatChips } from '../chips.js';
import { GoogleSignInButton } from '../components/GoogleSignInButton.js';

export function LobbyPage(): React.JSX.Element {
  const { user, accessToken, logout, upgrade, upgradeWithGoogle } = useAuth();
  const [tables, setTables] = useState<TableSummaryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showJoinPrivate, setShowJoinPrivate] = useState(false);
  const navigate = useNavigate();

  const refresh = (): void => {
    api
      .listTables()
      .then((res) => setTables(res.tables))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load tables.'));
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="lobby-page">
      <header className="lobby-header">
        <h1 className="lobby-brand">pokerclause</h1>
        {user && (
          <div className="lobby-user">
            <div className="lobby-user-info">
              <span className="lobby-user-name">{user.displayName}</span>
              <span className="lobby-user-chips">{formatChips(user.chips)}</span>
            </div>
            {user.isGuest && (
              <button type="button" className="btn-ghost" onClick={() => setShowUpgrade(true)}>
                Create account
              </button>
            )}
            <button type="button" className="btn-logout" onClick={() => void logout()}>
              Log out
            </button>
          </div>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="lobby-toolbar">
        <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
          + Create table
        </button>
        <button type="button" className="btn-secondary" onClick={() => setShowJoinPrivate(true)}>
          🔑 Join private table
        </button>
      </div>

      <div className="table-grid">
        {tables.map((t) => (
          <div className="table-card" key={t.tableId}>
            <div className="table-card-top">
              <h3 className="table-card-name">{t.name}</h3>
              <span className="table-card-seats" title="Seats filled">
                {t.seatsFilled}/{t.maxSeats}
              </span>
            </div>
            <div className="table-card-stats">
              <div className="table-card-stat">
                <span className="stat-label">Stakes</span>
                <span className="stat-value">
                  {formatChips(t.settings.smallBlind)}/{formatChips(t.settings.bigBlind)}
                </span>
              </div>
              <div className="table-card-stat">
                <span className="stat-label">Buy-in</span>
                <span className="stat-value">
                  {formatChips(t.settings.minBuyIn)}&ndash;{formatChips(t.settings.maxBuyIn)}
                </span>
              </div>
            </div>
            <button type="button" className="btn-primary table-card-join" onClick={() => void navigate(`/table/${t.tableId}`)}>
              Join table
            </button>
          </div>
        ))}
        {tables.length === 0 && <div className="table-grid-empty">No tables yet. Create one to get started.</div>}
      </div>

      {showCreate && accessToken && <CreateTableModal onClose={() => setShowCreate(false)} accessToken={accessToken} />}

      {showJoinPrivate && (
        <JoinPrivateModal
          onClose={() => setShowJoinPrivate(false)}
          onJoin={(id, code) => void navigate(`/table/${id}?code=${encodeURIComponent(code)}`)}
        />
      )}

      {showUpgrade && (
        <UpgradeModal
          onClose={() => setShowUpgrade(false)}
          onUpgrade={(email, password) => upgrade(email, password).then(() => setShowUpgrade(false))}
          onUpgradeGoogle={(idToken) => upgradeWithGoogle(idToken).then(() => setShowUpgrade(false))}
        />
      )}
    </div>
  );
}

function CreateTableModal({ onClose, accessToken }: { onClose: () => void; accessToken: string }): React.JSX.Element {
  const [name, setName] = useState('New Table');
  const [smallBlind, setSmallBlind] = useState(1);
  const [bigBlind, setBigBlind] = useState(2);
  const [maxSeats, setMaxSeats] = useState(6);
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ tableId: string; inviteCode: string | null } | null>(null);
  const navigate = useNavigate();

  const submit = (): void => {
    api
      .createTable({ name, smallBlind, bigBlind, maxSeats, isPrivate }, accessToken)
      .then((res) => setCreated({ tableId: res.tableId, inviteCode: res.inviteCode }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to create table.'));
  };

  if (created) {
    const link = created.inviteCode
      ? `${location.origin}/table/${created.tableId}?code=${created.inviteCode}`
      : `${location.origin}/table/${created.tableId}`;
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>Table created</h3>
          {created.inviteCode && (
            <>
              <p>Share this link — only people with it can join.</p>
              <input readOnly value={link} onClick={(e) => e.currentTarget.select()} />
            </>
          )}
          <div className="modal-actions">
            <button type="button" onClick={() => void navigate(`/table/${created.tableId}${created.inviteCode ? `?code=${created.inviteCode}` : ''}`)}>
              Go to table
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Create table</h3>
        {error && <div className="error-banner">{error}</div>}
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Small blind
          <input type="number" min={1} value={smallBlind} onChange={(e) => setSmallBlind(Number(e.target.value))} />
        </label>
        <label>
          Big blind
          <input type="number" min={1} value={bigBlind} onChange={(e) => setBigBlind(Number(e.target.value))} />
        </label>
        <label>
          Max seats
          <input type="number" min={2} max={9} value={maxSeats} onChange={(e) => setMaxSeats(Number(e.target.value))} />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
          Private (invite-only, hidden from the lobby list)
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function JoinPrivateModal({ onClose, onJoin }: { onClose: () => void; onJoin: (tableId: string, code: string) => void }): React.JSX.Element {
  const [tableId, setTableId] = useState('');
  const [code, setCode] = useState('');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Join a private table</h3>
        <p>Paste the table ID and invite code someone shared with you.</p>
        <label>
          Table ID
          <input value={tableId} onChange={(e) => setTableId(e.target.value)} />
        </label>
        <label>
          Invite code
          <input value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!tableId || !code} onClick={() => onJoin(tableId.trim(), code.trim())}>
            Join
          </button>
        </div>
      </div>
    </div>
  );
}

function UpgradeModal({
  onClose,
  onUpgrade,
  onUpgradeGoogle,
}: {
  onClose: () => void;
  onUpgrade: (email: string, password: string) => Promise<void>;
  onUpgradeGoogle: (idToken: string) => Promise<void>;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleGoogleCredential = useCallback(
    (idToken: string) => {
      setError(null);
      void onUpgradeGoogle(idToken).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed.'));
    },
    [onUpgradeGoogle],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Create an account</h3>
        <p>Keeps your chips and history under a password.</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="google-signin-row">
          <GoogleSignInButton onCredential={handleGoogleCredential} />
        </div>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onUpgrade(email, password).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed.'))}
          >
            Create account
          </button>
        </div>
      </div>
    </div>
  );
}

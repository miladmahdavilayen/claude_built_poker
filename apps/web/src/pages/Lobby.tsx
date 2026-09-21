import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api.js';
import type { TableSummaryDto } from '../api.js';
import { useAuth } from '../AuthContext.js';
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
      <div className="lobby-header">
        <h1>pokerclause</h1>
        {user && (
          <div className="lobby-user">
            <span>
              {user.displayName} &middot; {user.chips.toLocaleString()} chips
            </span>
            {user.isGuest && <button onClick={() => setShowUpgrade(true)}>Create account</button>}
            <button onClick={() => void logout()}>Log out</button>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="lobby-toolbar">
        <button type="button" onClick={() => setShowCreate(true)}>
          Create table
        </button>
        <button type="button" onClick={() => setShowJoinPrivate(true)}>
          Join private table
        </button>
      </div>

      <table className="table-list">
        <thead>
          <tr>
            <th>Name</th>
            <th>Stakes</th>
            <th>Buy-in</th>
            <th>Seats</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tables.map((t) => (
            <tr key={t.tableId}>
              <td>{t.name}</td>
              <td>
                {t.settings.smallBlind}/{t.settings.bigBlind}
              </td>
              <td>
                {t.settings.minBuyIn}&ndash;{t.settings.maxBuyIn}
              </td>
              <td>
                {t.seatsFilled}/{t.maxSeats}
              </td>
              <td>
                <button type="button" onClick={() => void navigate(`/table/${t.tableId}`)}>
                  Join
                </button>
              </td>
            </tr>
          ))}
          {tables.length === 0 && (
            <tr>
              <td colSpan={5}>No tables yet. Create one to get started.</td>
            </tr>
          )}
        </tbody>
      </table>

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

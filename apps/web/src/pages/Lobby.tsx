import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../api.js';
import { ApiError, isPracticeOnly, PRACTICE_STAKES, type PracticeStakes, type TableSummaryDto } from '../api.js';
import { useAuth } from '../AuthContext.js';
import { formatChips } from '../chips.js';
import { AnimatedBackground } from '../components/AnimatedBackground.js';
import { MoneyInput } from '../components/MoneyInput.js';

export function LobbyPage(): React.JSX.Element {
  const { user } = useAuth();
  return (
    <>
      <AnimatedBackground variant="lobby" />
      {user && isPracticeOnly(user) ? <PracticeLobby /> : <TablesLobby />}
    </>
  );
}

/** The admin's lobby — and an invited guest's: every public table, plus (for the admin) creating one. */
function TablesLobby(): React.JSX.Element {
  const { user, accessToken, logout } = useAuth();
  const [tables, setTables] = useState<TableSummaryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoinPrivate, setShowJoinPrivate] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const refresh = (): void => {
      api
        .listTables(accessToken)
        .then((res) => setTables(res.tables))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load tables.'));
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [accessToken]);

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
            {!user.isGuest && (
              <Link to="/profile" className="btn-ghost lobby-link-button">
                My profile
              </Link>
            )}
            {user.role === 'admin' && (
              <Link to="/admin" className="btn-ghost lobby-link-button">
                Admin
              </Link>
            )}
            <button type="button" className="btn-logout" onClick={() => void logout()}>
              Log out
            </button>
          </div>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="lobby-toolbar">
        {/* Only the owner creates real tables — every other signed-in
            player gets a practice table instead (PracticeLobby). */}
        {user?.role === 'admin' && (
          <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
            + Create table
          </button>
        )}
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
        {tables.length === 0 && <div className="table-grid-empty">No tables open right now.</div>}
      </div>

      {showCreate && accessToken && <CreateTableModal onClose={() => setShowCreate(false)} accessToken={accessToken} />}

      {showJoinPrivate && (
        <JoinPrivateModal
          onClose={() => setShowJoinPrivate(false)}
          onJoin={(id, code) => void navigate(`/table/${id}?code=${encodeURIComponent(code)}`)}
        />
      )}
    </div>
  );
}

function CreateTableModal({ onClose, accessToken }: { onClose: () => void; accessToken: string }): React.JSX.Element {
  const [name, setName] = useState('New Table');
  // Cents, like every amount (see packages/shared/src/money.ts) — the inputs show dollars.
  const [smallBlind, setSmallBlind] = useState<number | ''>(100);
  const [bigBlind, setBigBlind] = useState<number | ''>(200);
  // null = "follow the big blind" (the usual 40–100 big blinds) until the
  // creator types their own.
  const [minBuyInOverride, setMinBuyInOverride] = useState<number | '' | null>(null);
  const [maxBuyInOverride, setMaxBuyInOverride] = useState<number | '' | null>(null);
  const bb = bigBlind === '' ? 0 : bigBlind;
  const minBuyIn = minBuyInOverride ?? bb * 40;
  const maxBuyIn = maxBuyInOverride ?? bb * 100;
  const [maxSeats, setMaxSeats] = useState(6);
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ tableId: string; inviteCode: string | null } | null>(null);
  const navigate = useNavigate();

  const submit = (): void => {
    if (smallBlind === '' || bigBlind === '' || smallBlind <= 0 || bigBlind <= 0) {
      setError('Enter both blinds — as low as $0.01.');
      return;
    }
    if (minBuyIn === '' || maxBuyIn === '' || minBuyIn <= 0 || maxBuyIn <= 0) {
      setError('Enter a minimum and maximum buy-in.');
      return;
    }
    api
      .createTable({ name, smallBlind, bigBlind, maxSeats, isPrivate, minBuyIn, maxBuyIn }, accessToken)
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
        <div className="form-row">
          <label>
            Small blind ($)
            <MoneyInput minCents={1} cents={smallBlind} onChange={setSmallBlind} />
          </label>
          <label>
            Big blind ($)
            <MoneyInput minCents={1} cents={bigBlind} onChange={setBigBlind} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Min buy-in ($)
            <MoneyInput minCents={1} cents={minBuyIn} onChange={setMinBuyInOverride} />
          </label>
          <label>
            Max buy-in ($)
            <MoneyInput minCents={1} cents={maxBuyIn} onChange={setMaxBuyInOverride} />
          </label>
        </div>
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

const OPPONENT_CHOICES = [1, 2, 3, 4] as const;

/**
 * A signed-in player's lobby: they play only at their own temporary table
 * against computer players, so instead of a list of tables they pick how
 * many opponents (1–4, so at most 5 seats), the stakes, and their buy-in,
 * and get a table of their own. If they already have one open (say, after
 * a reload), they're offered the way back to it instead.
 */
function PracticeLobby(): React.JSX.Element {
  const { user, accessToken, logout, reloadUser } = useAuth();
  const navigate = useNavigate();
  const [openTableId, setOpenTableId] = useState<string | null | undefined>(undefined);
  const [bots, setBots] = useState<number>(3);
  const [stakes, setStakes] = useState<PracticeStakes>('low');
  const [buyIn, setBuyIn] = useState<number | ''>(() => Math.min(PRACTICE_STAKES.low.maxBuyIn, Math.max(PRACTICE_STAKES.low.minBuyIn, user?.chips ?? 0)));
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    // A practice table that just closed returned its chips — show the real balance.
    void reloadUser().catch(() => undefined);
    api
      .listTables(accessToken)
      .then((res) => setOpenTableId(res.practiceTableId))
      .catch(() => setOpenTableId(null));
  }, [accessToken, reloadUser]);

  if (!user) return <div className="page-centered">Loading...</div>;

  const range = PRACTICE_STAKES[stakes];
  const affordable = user.chips >= range.minBuyIn;
  const maxAffordable = Math.min(range.maxBuyIn, user.chips);

  const pickStakes = (next: PracticeStakes): void => {
    setStakes(next);
    setBuyIn(Math.min(PRACTICE_STAKES[next].maxBuyIn, Math.max(PRACTICE_STAKES[next].minBuyIn, user.chips)));
    setError(null);
  };

  const start = (): void => {
    if (!accessToken) return;
    if (buyIn === '' || buyIn < range.minBuyIn || buyIn > maxAffordable) {
      setError(`Choose a buy-in between ${formatChips(range.minBuyIn)} and ${formatChips(maxAffordable)}.`);
      return;
    }
    setError(null);
    setStarting(true);
    api
      .createPracticeTable({ bots, stakes, buyIn }, accessToken)
      .then((res) => void navigate(`/table/${res.tableId}`))
      .catch((err: unknown) => {
        setStarting(false);
        if (err instanceof ApiError && err.code === 'PRACTICE_TABLE_OPEN') {
          void api.listTables(accessToken).then((res) => setOpenTableId(res.practiceTableId));
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not start the game.');
      });
  };

  return (
    <div className="lobby-page">
      <header className="lobby-header">
        <h1 className="lobby-brand">pokerclause</h1>
        <div className="lobby-user">
          {user.avatarUrl && <img className="lobby-avatar" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <div className="lobby-user-info">
            <span className="lobby-user-name">{user.displayName}</span>
            <span className="lobby-user-chips" data-testid="lobby-balance">
              {formatChips(user.chips)}
            </span>
          </div>
          <Link to="/profile" className="btn-ghost lobby-link-button">
            My profile
          </Link>
          <button type="button" className="btn-logout" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      {openTableId ? (
        <section className="practice-card">
          <h2>Your game is still open</h2>
          <p className="profile-hint">Your seat and chips are waiting for you.</p>
          <button type="button" className="btn-primary practice-start" onClick={() => void navigate(`/table/${openTableId}`)}>
            Return to your table
          </button>
        </section>
      ) : openTableId === null ? (
        <section className="practice-card">
          <h2>Start a game</h2>
          <p className="profile-hint">Your own table against computer players. Leaving the table ends the game, and your chips go back to your balance.</p>

          <div className="practice-field">
            <span className="stat-label" id="practice-opponents-label">
              Opponents
            </span>
            <div className="practice-choices" role="radiogroup" aria-labelledby="practice-opponents-label">
              {OPPONENT_CHOICES.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={bots === n}
                  className={`practice-choice${bots === n ? ' selected' : ''}`}
                  onClick={() => setBots(n)}
                >
                  {n} {n === 1 ? 'bot' : 'bots'}
                </button>
              ))}
            </div>
            <span className="practice-field-note">
              {bots + 1} seats — you plus {bots} computer {bots === 1 ? 'player' : 'players'}
            </span>
          </div>

          <div className="practice-field">
            <span className="stat-label" id="practice-stakes-label">
              Stakes
            </span>
            <div className="practice-choices" role="radiogroup" aria-labelledby="practice-stakes-label">
              {(Object.keys(PRACTICE_STAKES) as PracticeStakes[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={stakes === key}
                  className={`practice-choice practice-choice-stakes${stakes === key ? ' selected' : ''}`}
                  onClick={() => pickStakes(key)}
                >
                  <span>{PRACTICE_STAKES[key].label}</span>
                  <span className="practice-choice-sub">
                    {formatChips(PRACTICE_STAKES[key].minBuyIn)}–{formatChips(PRACTICE_STAKES[key].maxBuyIn)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <label className="practice-field">
            <span className="stat-label">Buy-in ($)</span>
            <MoneyInput minCents={range.minBuyIn} maxCents={maxAffordable} cents={buyIn} onChange={setBuyIn} disabled={!affordable} />
          </label>

          {!affordable && (
            <p className="practice-warning">
              Your balance ({formatChips(user.chips)}) is below the {formatChips(range.minBuyIn)} minimum buy-in for these stakes.
            </p>
          )}
          {error && <div className="error-banner">{error}</div>}
          <button type="button" className="btn-primary practice-start" disabled={!affordable || starting} onClick={start}>
            {starting ? 'Setting up…' : 'Start game'}
          </button>
        </section>
      ) : (
        <div className="page-centered">Loading...</div>
      )}
    </div>
  );
}

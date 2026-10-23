import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api.js';
import type {
  AdminGuestDto,
  AdminUserDetailDto,
  AdminUserDto,
  DeletedUserDetailDto,
  DeletedUserDto,
  GameReportSummaryDto,
  LedgerEntryDto,
  PlayerGameDto,
  SignedWaiverDto,
  SignupKeyDto,
  UsedAccessKeyDto,
} from '../api.js';
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
  balance_restored: 'Balance restored (re-registered)',
};

/** "Oct 23, 2026, 2:05 PM" */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "+$40", "-$12.50", "$0" — a player's result, signed. */
function signedMoney(cents: number): string {
  return cents > 0 ? `+${formatChips(cents)}` : formatChips(cents);
}

/** "iPhone · Safari", "Windows · Chrome" — a readable gist of a user-agent string. The full string is shown beside it. */
function deviceGist(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error ? err.message : fallback);

/**
 * The owner's dashboard, as four folding sections:
 *
 * 1. Players — everyone who has played: registered (Google) players, and
 *    guests who came by an owner's invite (a seat invite, with the name the
 *    owner gave it, or an open-invite table's link). Searchable and
 *    filterable, tagged by kind. Each player's page holds everything about
 *    them — the access key they registered with, every agreement they
 *    signed or accepted (with its date, time, IP address and device), the
 *    games they played, their balance and activity.
 * 2. Game reports — every game's books.
 * 3. Access keys — generate one per new player; unused keys only (a used
 *    one moves under the player it registered).
 * 4. Deleted users — every deleted account, kept whole, for the owner only.
 *
 * Players starts open; the rest start folded. Each remembers, per browser,
 * whether it was left open.
 */
export function AdminDashboardPage(): React.JSX.Element {
  const { accessToken, user: me } = useAuth();
  const [users, setUsers] = useState<AdminUserDto[] | null>(null);
  const [guests, setGuests] = useState<AdminGuestDto[] | null>(null);
  const [keys, setKeys] = useState<SignupKeyDto[] | null>(null);
  const [deleted, setDeleted] = useState<DeletedUserDto[] | null>(null);
  const [reports, setReports] = useState<GameReportSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPlayers = (): void => {
    if (!accessToken) return;
    api
      .adminListUsers(accessToken)
      .then((res) => setUsers(res.users))
      .catch((err: unknown) => setError(errorText(err, 'Failed to load players.')));
    api
      .adminListGuests(accessToken)
      .then((res) => setGuests(res.guests))
      .catch((err: unknown) => setError(errorText(err, 'Failed to load guests.')));
  };
  const loadKeys = (): void => {
    if (!accessToken) return;
    api
      .adminListSignupKeys(accessToken)
      .then((res) => setKeys(res.keys))
      .catch((err: unknown) => setError(errorText(err, 'Failed to load access keys.')));
  };
  const loadDeleted = (): void => {
    if (!accessToken) return;
    api
      .adminListDeletedUsers(accessToken)
      .then((res) => setDeleted(res.users))
      .catch((err: unknown) => setError(errorText(err, 'Failed to load deleted users.')));
  };
  const loadReports = (): void => {
    if (!accessToken) return;
    api
      .adminListGameReports(accessToken)
      .then((res) => setReports(res.reports))
      .catch((err: unknown) => setError(errorText(err, 'Failed to load game reports.')));
  };
  useEffect(() => {
    loadPlayers();
    loadKeys();
    loadDeleted();
    loadReports();
  }, [accessToken]);

  // Deleting an account moves it to Deleted users.
  const onPlayersChanged = (): void => {
    loadPlayers();
    loadDeleted();
  };

  const playerCount = users && guests ? users.length + guests.length : undefined;

  return (
    <div className="lobby-page admin-page">
      <header className="lobby-header">
        <h1 className="lobby-brand">Admin dashboard</h1>
        <Link to="/lobby" className="btn-ghost lobby-link-button">
          &larr; Lobby
        </Link>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <MyBalanceCard balance={users?.find((u) => u.id === me?.id)?.chips ?? null} onChanged={loadPlayers} />

      {accessToken && (
        <>
          <AdminSection id="players" title="Players" count={playerCount} hint="Registered players and invited guests" defaultOpen>
            <PlayersPanel accessToken={accessToken} users={users} guests={guests} onChanged={onPlayersChanged} />
          </AdminSection>
          <AdminSection id="reports" title="Game reports" count={reports?.length} hint="Every game's books">
            <GameReportsPanel accessToken={accessToken} reports={reports} onRefresh={loadReports} />
          </AdminSection>
          <AdminSection id="keys" title="Access keys" count={keys?.filter((k) => k.status === 'active').length} hint="Invite new players to sign up">
            <AccessKeysPanel accessToken={accessToken} keys={keys} onChanged={loadKeys} />
          </AdminSection>
          <AdminSection id="deleted" title="Deleted users" count={deleted?.length} hint="Kept for your records only">
            <DeletedUsersPanel accessToken={accessToken} users={deleted} />
          </AdminSection>
        </>
      )}
    </div>
  );
}

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(`admin-section-${id}`);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

/** One folding section of the dashboard: a big tappable header (title, count, a hint) that opens and closes it. */
function AdminSection({
  id,
  title,
  count,
  hint,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  count: number | undefined;
  hint: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const bodyId = useId();
  const toggle = (): void => {
    setOpen((was) => {
      try {
        localStorage.setItem(`admin-section-${id}`, was ? '0' : '1');
      } catch {
        // Only a convenience — it just won't be remembered.
      }
      return !was;
    });
  };
  return (
    <section className={`admin-section${open ? ' admin-section-open' : ''}`} data-testid={`admin-section-${id}`}>
      <h2 className="admin-section-heading">
        <button type="button" className="admin-section-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
          <span className="admin-section-text">
            <span className="admin-section-name">
              {title}
              {count !== undefined && <span className="admin-section-count">{count}</span>}
            </span>
            <span className="admin-section-hint">{hint}</span>
          </span>
          <svg className="admin-section-chevron" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </h2>
      {open && (
        <div id={bodyId} className="admin-section-body">
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * The owner's own balance, front and centre: add to it, or set it to an
 * exact amount (up to MAX_BALANCE_CENTS). Same ledgered adjustments as the
 * per-player panel, just without having to find your own row.
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
      .catch((err: unknown) => setError(errorText(err, 'Failed to update your balance.')))
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

// --- Players --------------------------------------------------------------

type PlayerFilter = 'all' | 'registered' | 'invited' | 'open-link';
type PlayerSort = 'newest' | 'oldest' | 'name';
type PlayerEntry = { kind: 'registered'; user: AdminUserDto } | { kind: 'guest'; guest: AdminGuestDto };
type Selected = { kind: 'registered' | 'guest'; id: string } | null;

const entryName = (e: PlayerEntry): string => (e.kind === 'registered' ? e.user.displayName : e.guest.displayName);
const entryDate = (e: PlayerEntry): number => new Date(e.kind === 'registered' ? e.user.createdAt : e.guest.joinedAt).getTime();

function matchesFilter(e: PlayerEntry, filter: PlayerFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'registered') return e.kind === 'registered';
  return e.kind === 'guest' && (filter === 'invited' ? e.guest.inviteKind === 'seat-invite' : e.guest.inviteKind === 'open-link');
}

function matchesSearch(e: PlayerEntry, q: string): boolean {
  if (!q) return true;
  const fields =
    e.kind === 'registered'
      ? [e.user.displayName, e.user.email, e.user.accessKeyLabel]
      : [e.guest.displayName, e.guest.adminNickname, e.guest.tableName, e.guest.ipAddress];
  return fields.some((f) => f?.toLowerCase().includes(q));
}

/** "Registered", "Guest · invited", "Guest · open link" — the player's kind, as a coloured tag. */
function PlayerKindTag({ entry }: { entry: { kind: 'registered' } | { kind: 'guest'; inviteKind: AdminGuestDto['inviteKind'] } }): React.JSX.Element {
  if (entry.kind === 'registered') return <span className="player-tag player-tag-registered">Registered</span>;
  return <span className="player-tag player-tag-guest">{entry.inviteKind === 'seat-invite' ? 'Guest · invited' : 'Guest · open link'}</span>;
}

function PlayersPanel({
  accessToken,
  users,
  guests,
  onChanged,
}: {
  accessToken: string;
  users: AdminUserDto[] | null;
  guests: AdminGuestDto[] | null;
  onChanged: () => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PlayerFilter>('all');
  const [sort, setSort] = useState<PlayerSort>('newest');
  const [selected, setSelected] = useState<Selected>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const all: PlayerEntry[] = [...(users ?? []).map((user) => ({ kind: 'registered' as const, user })), ...(guests ?? []).map((guest) => ({ kind: 'guest' as const, guest }))];
  const counts: Record<PlayerFilter, number> = {
    all: all.length,
    registered: all.filter((e) => matchesFilter(e, 'registered')).length,
    invited: all.filter((e) => matchesFilter(e, 'invited')).length,
    'open-link': all.filter((e) => matchesFilter(e, 'open-link')).length,
  };
  const q = search.trim().toLowerCase();
  const shown = all
    .filter((e) => matchesFilter(e, filter) && matchesSearch(e, q))
    .sort((a, b) => (sort === 'name' ? entryName(a).localeCompare(entryName(b)) : sort === 'oldest' ? entryDate(a) - entryDate(b) : entryDate(b) - entryDate(a)));

  // Only registered, non-admin players can be deleted — "select all" never
  // includes an id the server would just skip (see CANNOT_DELETE_ADMIN).
  const selectableIds = shown.flatMap((e) => (e.kind === 'registered' && e.user.role !== 'admin' ? [e.user.id] : []));
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => checkedIds.has(id));

  const open = (next: Selected): void => {
    setSelected(next);
    // On a phone the detail sits below the list — bring it into view.
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 767px)').matches) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const toggleChecked = (id: string): void => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRowDeleted = (id: string): void => {
    if (selected?.id === id) setSelected(null);
    setCheckedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    onChanged();
  };

  const bulkDelete = (): void => {
    if (checkedIds.size === 0) return;
    setBulkBusy(true);
    setError(null);
    api
      .adminBulkDeleteUsers([...checkedIds], accessToken)
      .then(() => {
        if (selected && checkedIds.has(selected.id)) setSelected(null);
        setCheckedIds(new Set());
        onChanged();
      })
      .catch((err: unknown) => setError(errorText(err, 'Failed to delete the selected accounts.')))
      .finally(() => setBulkBusy(false));
  };

  const FILTERS: { id: PlayerFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'registered', label: 'Registered' },
    { id: 'invited', label: 'Invited guests' },
    { id: 'open-link', label: 'Open-link guests' },
  ];

  return (
    <div className="admin-players">
      <div className="admin-players-controls">
        <input
          type="search"
          className="admin-search"
          placeholder="Search by name or email..."
          aria-label="Search players by name, email, the name you gave them, or table"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="Sort players" value={sort} onChange={(e) => setSort(e.target.value as PlayerSort)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>
      <div className="admin-filter-chips" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`admin-filter-chip${filter === f.id ? ' admin-filter-chip-on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span className="admin-filter-count">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      <p className="profile-hint admin-players-hint">Search also finds the name you gave someone (an access key or a seat invite), and a guest&rsquo;s table.</p>

      {selectableIds.length > 0 && (
        <div className="admin-list-toolbar">
          <label className="admin-select-all">
            <input type="checkbox" checked={allSelected} onChange={() => setCheckedIds(allSelected ? new Set() : new Set(selectableIds))} />
            Select all registered
          </label>
          {checkedIds.size > 0 && (
            <button type="button" className="btn-owner-action btn-owner-danger" disabled={bulkBusy} onClick={bulkDelete}>
              {bulkBusy ? 'Deleting…' : `Delete ${String(checkedIds.size)} selected`}
            </button>
          )}
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <div className="admin-layout">
        <div className="admin-user-list">
          {(users === null || guests === null) && <p className="profile-hint">Loading…</p>}
          {shown.map((e) =>
            e.kind === 'registered' ? (
              <AdminUserRow
                key={e.user.id}
                user={e.user}
                isActive={selected?.id === e.user.id}
                isChecked={checkedIds.has(e.user.id)}
                onOpen={() => open({ kind: 'registered', id: e.user.id })}
                onToggleChecked={() => toggleChecked(e.user.id)}
                onDeleted={() => handleRowDeleted(e.user.id)}
              />
            ) : (
              <GuestRow key={e.guest.id} guest={e.guest} isActive={selected?.id === e.guest.id} onOpen={() => open({ kind: 'guest', id: e.guest.id })} />
            ),
          )}
          {users !== null && guests !== null && shown.length === 0 && <p className="profile-hint">No players match.</p>}
        </div>

        <div ref={detailRef} className="admin-detail-slot">
          {selected?.kind === 'registered' && <AdminUserDetail key={selected.id} userId={selected.id} onClose={() => setSelected(null)} onChanged={onChanged} />}
          {selected?.kind === 'guest' && <GuestDetail key={selected.id} guestId={selected.id} accessToken={accessToken} onClose={() => setSelected(null)} />}
          {selected === null && shown.length > 0 && <p className="profile-hint admin-detail-placeholder">Choose a player to see everything about them.</p>}
        </div>
      </div>
    </div>
  );
}

const SWIPE_REVEAL_PX = 84;
const SWIPE_OPEN_THRESHOLD_PX = 40;
const TAP_MAX_MOVEMENT_PX = 8;

/**
 * One registered player: a leading checkbox (untouched by the swipe gesture
 * below it), and a swipeable content area — dragging it left reveals a red
 * "Delete" action underneath, the same convention as a native mobile mail
 * app's swipe-to-delete. Tapping the revealed action deletes immediately
 * (the swipe itself is the deliberate confirmation), and the admin's own
 * row never becomes swipeable at all (it can't be deleted regardless).
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
    if (!dragStartRef.current) {
      if (!canDelete) onOpen(); // the admin's own row: no swipe, just a tap
      return;
    }
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
            aria-label={`Select ${user.displayName}`}
            checked={isChecked}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onChange={onToggleChecked}
          />
        ) : (
          <span className="admin-user-row-checkbox" />
        )}
        <span className="admin-user-row-main">
          <span className="admin-user-row-name">
            {user.displayName}
            {user.role === 'admin' ? <span className="player-tag player-tag-admin">admin</span> : <PlayerKindTag entry={{ kind: 'registered' }} />}
          </span>
          <span className="admin-user-row-sub">
            {user.accessKeyLabel && <span className="admin-given-name">&ldquo;{user.accessKeyLabel}&rdquo;</span>}
            {user.email ?? 'no email'}
          </span>
        </span>
        <span className="admin-user-row-chips">{formatChips(user.chips)}</span>
      </div>
    </div>
  );
}

/** One guest: their name, kind of invite, the name the owner gave the invite, and where and when they joined. */
function GuestRow({ guest, isActive, onOpen }: { guest: AdminGuestDto; isActive: boolean; onOpen: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`admin-user-row admin-guest-row ${isActive ? 'admin-user-row-active' : ''}`} onClick={onOpen}>
      <span className="admin-user-row-checkbox" />
      <span className="admin-user-row-main">
        <span className="admin-user-row-name">
          {guest.displayName}
          <PlayerKindTag entry={{ kind: 'guest', inviteKind: guest.inviteKind }} />
        </span>
        <span className="admin-user-row-sub">
          {guest.adminNickname && <span className="admin-given-name">&ldquo;{guest.adminNickname}&rdquo;</span>}
          {guest.tableName ?? 'a table'} · {new Date(guest.joinedAt).toLocaleDateString()}
        </span>
      </span>
    </button>
  );
}

/** A labelled list of facts about someone. Empty values are left out. */
function Fields({ items }: { items: [string, React.ReactNode][] }): React.JSX.Element {
  return (
    <dl className="admin-fields">
      {items
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k} className="admin-field">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** One part of a player's page, titled. */
function DetailSection({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <section className="admin-detail-section" data-testid={testId}>
      <h4 className="admin-detail-section-title">{title}</h4>
      {children}
    </section>
  );
}

/** The access key someone registered with, kept under them. */
function AccessKeyCard({ accessKey }: { accessKey: UsedAccessKeyDto }): React.JSX.Element {
  return (
    <div className="admin-record-card">
      <span className="admin-key-label">
        {accessKey.label} <span className="admin-key-hint">…{accessKey.hint}</span>
      </span>
      <span className="admin-report-meta">
        Generated {when(accessKey.createdAt)}
        {accessKey.usedAt ? ` · used to sign up ${when(accessKey.usedAt)}` : ''}
      </span>
      {accessKey.email && <span className="admin-report-meta">Only for {accessKey.email}</span>}
    </div>
  );
}

/**
 * Every signed copy of the friendly-game waiver this player signed — View
 * opens the signed PDF; the record is the authorization record (JSON) with
 * the PDF's SHA-256, for proving it hasn't been altered.
 */
function SignedWaivers({ waivers, accessToken }: { waivers: SignedWaiverDto[]; accessToken: string }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  const save = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const view = (id: string): void => {
    // Opened now, inside the click, so it isn't blocked as a pop-up; filled in once the PDF arrives.
    const tab = window.open('', '_blank');
    api
      .adminWaiverFile(id, 'pdf', accessToken)
      .then(({ blob }) => {
        const url = URL.createObjectURL(blob);
        if (tab) tab.location.href = url;
        else window.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch((err: unknown) => {
        tab?.close();
        setError(errorText(err, 'Failed to open the waiver.'));
      });
  };

  const download = (id: string, kind: 'pdf' | 'record'): void => {
    api
      .adminWaiverFile(id, kind, accessToken)
      .then(({ blob, filename }) => save(blob, filename))
      .catch((err: unknown) => setError(errorText(err, 'Download failed.')));
  };

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <ul className="admin-key-list admin-record-list">
        {waivers.map((w) => (
          <li key={w.id} className="admin-key-row admin-waiver-row" data-testid={`signed-waiver-${w.id}`}>
            <div className="admin-key-info">
              <span className="admin-key-label">
                Friendly game agreement <span className="admin-key-hint">v{w.version} · initials {w.initials}</span>
              </span>
              <span className="admin-report-meta">Signed {when(w.signedAt)}</span>
              <span className="admin-report-meta">
                IP {w.ipAddress ?? 'unknown'} · {deviceGist(w.userAgent)}
              </span>
            </div>
            <div className="admin-waiver-actions">
              <button type="button" onClick={() => view(w.id)}>
                View
              </button>
              <button type="button" onClick={() => download(w.id, 'pdf')}>
                PDF
              </button>
              <button type="button" className="btn-ghost" onClick={() => download(w.id, 'record')}>
                Record
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A player's agreements: the signed waivers, or — for an agreement made before signed copies were kept — what was recorded. */
function Agreements({
  waiver,
  signed,
  accessToken,
}: {
  waiver: { version: number; initials: string; acceptedAt: string } | null;
  signed: SignedWaiverDto[];
  accessToken: string;
}): React.JSX.Element {
  if (signed.length > 0) return <SignedWaivers waivers={signed} accessToken={accessToken} />;
  if (waiver) return <p className="profile-hint">Agreed (initials {waiver.initials}, version {waiver.version}) on {when(waiver.acceptedAt)} — before signed copies were kept.</p>;
  return <p className="profile-hint">Hasn&rsquo;t signed the agreement yet.</p>;
}

/** The games someone played, newest first, with their result in each. */
function GamesList({ games }: { games: PlayerGameDto[] }): React.JSX.Element {
  if (games.length === 0) return <p className="profile-hint">No games yet.</p>;
  return (
    <ul className="admin-games">
      {games.map((g) => (
        <li key={g.reportId} className="admin-game-row">
          <span className="admin-game-main">
            <span className="admin-report-name">{g.tableName}</span>
            <span className="admin-report-meta">
              {when(g.startedAt)}
              {g.stakes ? ` · ${g.stakes}` : ''} · {g.handsPlayed} hand{g.handsPlayed === 1 ? '' : 's'}, won {g.handsWon}
              {g.status === 'live' ? ' · still playing' : ''}
            </span>
          </span>
          <span className={`admin-game-net ${g.net > 0 ? 'net-up' : g.net < 0 ? 'net-down' : 'net-even'}`}>{signedMoney(g.net)}</span>
        </li>
      ))}
    </ul>
  );
}

function ActivityList({ entries }: { entries: LedgerEntryDto[] }): React.JSX.Element {
  if (entries.length === 0) return <p className="profile-hint">Nothing yet.</p>;
  return (
    <div className="profile-history">
      {entries.map((entry) => (
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
      .catch((err: unknown) => setError(errorText(err, 'Failed to load this player.')));
  };

  useEffect(load, [userId, accessToken]);

  if (!detail || !accessToken) {
    return (
      <div className="admin-user-detail">
        {error ? <div className="error-banner">{error}</div> : <p className="profile-hint">Loading...</p>}
      </div>
    );
  }

  const submitRename = (): void => {
    if (!displayName.trim()) return;
    setBusy(true);
    api
      .adminUpdateUser(userId, displayName.trim(), accessToken)
      .then(() => {
        load();
        onChanged();
      })
      .catch((err: unknown) => setError(errorText(err, 'Failed to rename.')))
      .finally(() => setBusy(false));
  };

  const submitChips = (): void => {
    if (chipAmount === 0) return;
    setBusy(true);
    api
      .adminAdjustChips(userId, chipAmount, chipReason || 'Admin adjustment', accessToken)
      .then(() => {
        setChipAmount(0);
        load();
        onChanged();
      })
      .catch((err: unknown) => setError(errorText(err, 'Failed to adjust chips.')))
      .finally(() => setBusy(false));
  };

  const submitSetChips = (): void => {
    if (chipAmount < 0) return;
    setBusy(true);
    api
      .adminSetChips(userId, chipAmount, chipReason || 'Admin set balance', accessToken)
      .then(() => {
        setChipAmount(0);
        load();
        onChanged();
      })
      .catch((err: unknown) => setError(errorText(err, 'Failed to set the balance.')))
      .finally(() => setBusy(false));
  };

  const submitDelete = (): void => {
    setBusy(true);
    api
      .adminDeleteUser(userId, accessToken)
      .then(() => {
        onChanged();
        onClose();
      })
      .catch((err: unknown) => setError(errorText(err, 'Failed to delete this account.')))
      .finally(() => setBusy(false));
  };

  return (
    <div className="admin-user-detail">
      <div className="admin-user-detail-header">
        <h3>
          {detail.displayName} {detail.role === 'admin' ? <span className="player-tag player-tag-admin">admin</span> : <PlayerKindTag entry={{ kind: 'registered' }} />}
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="profile-summary">
        <div className="profile-stat-card">
          <span className="stat-label">Account</span>
          <span className="stat-value">{detail.hasGoogle ? 'Google' : 'Password'}</span>
        </div>
        <div className="profile-stat-card">
          <span className="stat-label">Balance</span>
          <span className="stat-value">{formatChips(detail.chips)}</span>
        </div>
        {detail.hasGoogle && (
          <div className="profile-stat-card">
            <span className="stat-label">Waiver</span>
            <span className="stat-value">{detail.waiver ? `Agreed (${detail.waiver.initials}) · ${new Date(detail.waiver.acceptedAt).toLocaleDateString()}` : 'Not agreed yet'}</span>
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

      <Fields
        items={[
          ['Name you gave them', detail.accessKeyLabel],
          ['Email', detail.email],
          ['Signed up', when(detail.createdAt)],
          ['Last Google sign-in', detail.lastLoginAt ? when(detail.lastLoginAt) : null],
        ]}
      />

      {detail.hasGoogle && (
        <DetailSection title="Access key" testId="player-access-key">
          {detail.accessKey ? <AccessKeyCard accessKey={detail.accessKey} /> : <p className="profile-hint">Signed up without an access key.</p>}
        </DetailSection>
      )}

      {detail.hasGoogle && (
        <DetailSection title="Agreements" testId="player-agreements">
          <Agreements waiver={detail.waiver} signed={detail.signedWaivers} accessToken={accessToken} />
        </DetailSection>
      )}

      <DetailSection title="Games played">
        <GamesList games={detail.games} />
      </DetailSection>

      <DetailSection title="Name and balance">
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
      </DetailSection>

      <DetailSection title="Recent activity">
        <ActivityList entries={detail.recentEntries} />
      </DetailSection>

      {detail.role !== 'admin' && (
        <div className="profile-danger-zone">
          {!deleteConfirm ? (
            <button type="button" className="btn-owner-action btn-owner-danger" onClick={() => setDeleteConfirm(true)}>
              Delete this account
            </button>
          ) : (
            <>
              <p className="profile-hint">Deletes {detail.displayName}&rsquo;s account. Everything about it is kept under Deleted users, for your eyes only.</p>
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

/** A guest's page: who they said they were, the invite they came by, their acceptance of the guest terms, and their games. */
function GuestDetail({ guestId, accessToken, onClose }: { guestId: string; accessToken: string; onClose: () => void }): React.JSX.Element {
  const [detail, setDetail] = useState<(AdminGuestDto & { games: PlayerGameDto[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminGetGuest(guestId, accessToken)
      .then(setDetail)
      .catch((err: unknown) => setError(errorText(err, 'Failed to load this guest.')));
  }, [guestId, accessToken]);

  if (!detail) {
    return <div className="admin-user-detail">{error ? <div className="error-banner">{error}</div> : <p className="profile-hint">Loading...</p>}</div>;
  }

  return (
    <div className="admin-user-detail" data-testid="guest-detail">
      <div className="admin-user-detail-header">
        <h3>
          {detail.displayName} <PlayerKindTag entry={{ kind: 'guest', inviteKind: detail.inviteKind }} />
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <Fields
        items={[
          ['Name you gave them', detail.adminNickname],
          ['Came by', detail.inviteKind === 'seat-invite' ? 'Your seat invite (a one-person link)' : 'The table’s open-invite link'],
          ['Table', detail.tableName],
          ['Joined', when(detail.joinedAt)],
        ]}
      />

      <DetailSection title="Agreement" testId="guest-agreement">
        <div className="admin-record-card">
          <span className="admin-key-label">
            Guest terms <span className="admin-key-hint">v{detail.termsVersion}</span> <span className="admin-key-status admin-key-status-active">Agreed</span>
          </span>
          <Fields
            items={[
              ['Agreed on', when(detail.termsAcceptedAt)],
              ['IP address', detail.ipAddress ?? 'unknown'],
              ['Device', deviceGist(detail.userAgent)],
              ['Browser details', detail.userAgent ? <span className="admin-user-agent">{detail.userAgent}</span> : null],
            ]}
          />
        </div>
      </DetailSection>

      <DetailSection title="Games played">
        <GamesList games={detail.games} />
      </DetailSection>
    </div>
  );
}

// --- Access keys ----------------------------------------------------------

const KEY_STATUS_LABEL: Record<SignupKeyDto['status'], string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
};

/**
 * One-time access keys for new players (see apps/server's signupKeys.ts):
 * generate one per person, send it to them, and it registers exactly one
 * Google account — optionally only theirs, if you give their email. The
 * key is shown here once, right after generating it; only its last four
 * characters are kept for telling keys apart. Once used, a key moves under
 * the player it registered — with the name given here — in Players.
 */
function AccessKeysPanel({ accessToken, keys, onChanged }: { accessToken: string; keys: SignupKeyDto[] | null; onChanged: () => void }): React.JSX.Element {
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [days, setDays] = useState(7);
  const [fresh, setFresh] = useState<{ key: string; label: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState<'key' | 'message' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        onChanged();
      })
      .catch((err: unknown) => setError(errorText(err, 'Failed to generate a key.')))
      .finally(() => setBusy(false));
  };

  const revoke = (id: string): void => {
    api
      .adminRevokeSignupKey(id, accessToken)
      .then(onChanged)
      .catch((err: unknown) => setError(errorText(err, 'Failed to revoke the key.')));
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
    <div className="admin-keys" data-testid="admin-access-keys">
      <p className="profile-hint">
        One key per new player. Each works once, to register one Google account, and expires if unused. Once used, it moves under that player in Players — with the name you give it here.
      </p>
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

      {keys?.length === 0 && <p className="profile-hint">No unused keys.</p>}
      {keys && keys.length > 0 && (
        <ul className="admin-key-list">
          {keys.map((k) => (
            <li key={k.id} className="admin-key-row" data-testid={`access-key-${k.id}`}>
              <div className="admin-key-info">
                <span className="admin-key-label">
                  {k.label} <span className="admin-key-hint">…{k.hint}</span>
                </span>
                <span className="admin-report-meta">
                  {k.email ? `${k.email} · ` : ''}
                  {k.status === 'revoked' ? 'revoked — never used' : `${k.status === 'active' ? 'expires' : 'expired'} ${new Date(k.expiresAt).toLocaleDateString()}`}
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
    </div>
  );
}

// --- Deleted users --------------------------------------------------------

/**
 * Every account that was deleted — by its owner or by you — kept whole:
 * the balance it had, its access key and the name you gave it, its signed
 * agreements, games and full activity. For your records only; it never
 * stops the same person registering again.
 */
function DeletedUsersPanel({ accessToken, users }: { accessToken: string; users: DeletedUserDto[] | null }): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const q = search.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => !q || [u.displayName, u.email, u.accessKeyLabel].some((f) => f?.toLowerCase().includes(q)));

  return (
    <div className="admin-deleted" data-testid="admin-deleted-users">
      <p className="profile-hint">Everything about each deleted account, as it was when it was deleted. Only you can see this, and it never stops anyone signing up again.</p>
      {users && users.length > 0 && (
        <input type="search" className="admin-search" placeholder="Search deleted users..." aria-label="Search deleted users" value={search} onChange={(e) => setSearch(e.target.value)} />
      )}
      {users === null && <p className="profile-hint">Loading…</p>}
      {users?.length === 0 && <p className="profile-hint">No one has deleted their account.</p>}
      <div className="admin-layout">
        <div className="admin-user-list">
          {shown.map((u) => (
            <button key={u.id} type="button" className={`admin-user-row admin-deleted-row ${selectedId === u.id ? 'admin-user-row-active' : ''}`} onClick={() => setSelectedId(u.id)}>
              <span className="admin-user-row-checkbox" />
              <span className="admin-user-row-main">
                <span className="admin-user-row-name">
                  {u.displayName} <span className="player-tag player-tag-deleted">Deleted</span>
                </span>
                <span className="admin-user-row-sub">
                  {u.accessKeyLabel && <span className="admin-given-name">&ldquo;{u.accessKeyLabel}&rdquo;</span>}
                  {u.email ?? 'no email'} · {new Date(u.deletedAt).toLocaleDateString()}
                </span>
              </span>
              <span className="admin-user-row-chips">{formatChips(u.balance)}</span>
            </button>
          ))}
        </div>
        <div className="admin-detail-slot">{selectedId && <DeletedUserDetail key={selectedId} id={selectedId} accessToken={accessToken} onClose={() => setSelectedId(null)} />}</div>
      </div>
    </div>
  );
}

function DeletedUserDetail({ id, accessToken, onClose }: { id: string; accessToken: string; onClose: () => void }): React.JSX.Element {
  const [detail, setDetail] = useState<DeletedUserDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminGetDeletedUser(id, accessToken)
      .then(setDetail)
      .catch((err: unknown) => setError(errorText(err, 'Failed to load this account.')));
  }, [id, accessToken]);

  if (!detail) {
    return <div className="admin-user-detail">{error ? <div className="error-banner">{error}</div> : <p className="profile-hint">Loading...</p>}</div>;
  }

  return (
    <div className="admin-user-detail" data-testid="deleted-user-detail">
      <div className="admin-user-detail-header">
        <h3>
          {detail.displayName} <span className="player-tag player-tag-deleted">Deleted</span>
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="profile-summary">
        <div className="profile-stat-card">
          <span className="stat-label">Balance when deleted</span>
          <span className="stat-value">{formatChips(detail.balance)}</span>
        </div>
        <div className="profile-stat-card">
          <span className="stat-label">Net from playing</span>
          <span className={`stat-value ${detail.netPlayResult >= 0 ? 'profile-stat-positive' : 'profile-stat-negative'}`}>
            {detail.netPlayResult >= 0 ? '+' : ''}
            {formatChips(detail.netPlayResult)}
          </span>
        </div>
        <div className="profile-stat-card">
          <span className="stat-label">Deleted</span>
          <span className="stat-value">
            {new Date(detail.deletedAt).toLocaleDateString()} · {detail.deletedBy === 'self' ? 'by them' : 'by you'}
          </span>
        </div>
      </div>

      <Fields
        items={[
          ['Name you gave them', detail.accessKeyLabel],
          ['Email', detail.email],
          ['Account', detail.hasGoogle ? 'Google' : 'Password'],
          ['Signed up', when(detail.createdAt)],
          ['Last Google sign-in', detail.lastLoginAt ? when(detail.lastLoginAt) : null],
          ['Deleted', when(detail.deletedAt)],
        ]}
      />

      <DetailSection title="Access key">
        {detail.accessKey ? <AccessKeyCard accessKey={detail.accessKey} /> : <p className="profile-hint">Signed up without an access key.</p>}
      </DetailSection>

      <DetailSection title="Agreements">
        <Agreements waiver={detail.waiver} signed={detail.signedWaivers} accessToken={accessToken} />
      </DetailSection>

      <DetailSection title="Games played">
        <GamesList games={detail.games} />
      </DetailSection>

      <DetailSection title={`All activity (${String(detail.ledger.length)})`}>
        <ActivityList entries={detail.ledger} />
      </DetailSection>
    </div>
  );
}

// --- Game reports ---------------------------------------------------------

type ReportSort = 'newest' | 'oldest' | 'table';

/**
 * Every game's books — live games (still being played) and finished ones,
 * kept permanently — grouped by the day they started, each titled by its
 * table's name, with the headline numbers and standings at a glance (from
 * the structured game_reports / game_report_players columns, no YAML
 * parsing). The same YAML/PDF downloads as the table's own owner menu;
 * this is where a finished game's report lives once its table is gone.
 * See apps/server/src/game/gameBook.ts.
 */
function GameReportsPanel({ accessToken, reports, onRefresh }: { accessToken: string; reports: GameReportSummaryDto[] | null; onRefresh: () => void }): React.JSX.Element {
  const [sort, setSort] = useState<ReportSort>('newest');
  const [search, setSearch] = useState('');

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
    <div className="admin-reports">
      <div className="admin-reports-controls">
        {reports && reports.length > 0 && (
          <>
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
          </>
        )}
        <button type="button" className="btn-secondary" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {reports === null && <p className="profile-hint">Loading…</p>}
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
    </div>
  );
}

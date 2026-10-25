import type { ProjectedSeat, ProjectedTableState } from '@pokerclause/shared';
import { useEffect, useMemo, useState } from 'react';
import { formatChips } from '../chips.js';
import type { TableSocketApi } from '../useTableSocket.js';
import { MoneyInput } from './MoneyInput.js';
import { ReportDownloads } from './ReportDownloads.js';
import { diffSettings, formFromSettings, TableSettingsFields, type SettingsForm } from './TableSettingsForm.js';

/** The form starts from where the table is heading — settings in force, overlaid with anything queued for the next hand. */
function formFromState(state: ProjectedTableState): SettingsForm {
  return formFromSettings(state.tableName, { ...state.settings, ...state.pendingSettings });
}

function seatBadges(seat: ProjectedSeat): string[] {
  const badges: string[] = [];
  if (seat.isBot) badges.push('bot');
  if (seat.leavingAfterHand) badges.push('leaving after this hand');
  if (seat.joiningNextHand) badges.push('joins next hand');
  if (seat.pendingChips > 0) badges.push(`+${formatChips(seat.pendingChips)} after this hand`);
  if (seat.status === 'sitting-out' && !seat.joiningNextHand) badges.push('sitting out');
  return badges;
}

/**
 * The owner's full table control panel — everything that used to need a
 * trip back to the lobby (or couldn't be done at all), available any time,
 * mid-hand included. The server decides what applies instantly and what
 * waits for the hand to end (see LiveTable.updateSettings / addChips /
 * removeSeatOccupant); this panel just says so. Every control is gated by
 * the same permission the server enforces: chip-economy actions (adding
 * chips, removing a real player, inviting, reset/terminate) need the
 * admin; table layout and settings need `canManage`.
 */
export function OwnerMenu({
  state,
  sock,
  isAdmin,
  accessToken,
  tableId,
  onClose,
  onAddBot,
  onInvite,
  onSitHere,
  onReset,
  onTerminate,
}: {
  state: ProjectedTableState;
  sock: TableSocketApi;
  isAdmin: boolean;
  accessToken: string | null;
  tableId: string;
  onClose: () => void;
  onAddBot: (seatId: number) => void;
  onInvite: (seatId: number) => void;
  onSitHere: ((seatId: number) => void) | null;
  onReset: () => void;
  onTerminate: () => void;
}): React.JSX.Element {
  const base = useMemo(() => formFromState(state), [state]);
  const [form, setForm] = useState<SettingsForm>(base);
  const [touched, setTouched] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [chipsFor, setChipsFor] = useState<number | null>(null);
  const [chipsAmount, setChipsAmount] = useState<number | ''>('');
  const [confirming, setConfirming] = useState<{ seatId: number; action: 'remove' | 'delete' } | null>(null);
  const [seatMessage, setSeatMessage] = useState<string | null>(null);

  // Live table changes (someone else's edit, a hand ending and pending
  // values applying) flow into the form — unless the owner is mid-edit.
  useEffect(() => {
    if (!touched) setForm(base);
  }, [base, touched]);

  useEffect(() => {
    if (!state.settings.isPrivate) {
      setInviteCode(null);
      return;
    }
    void sock.getInviteCode().then(setInviteCode);
    // Re-fetched only when privacy flips, not on every state update.
  }, [state.settings.isPrivate]);

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]): void => {
    setTouched(true);
    setSaveMessage(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const inHand = state.phase === 'in-hand';
  // Hands this game has finished — the report covers exactly these (a hand in progress isn't in it yet).
  const completedHands = inHand ? state.handNumber - 1 : state.handNumber;
  const patch = diffSettings(form, base);
  const hasChanges = typeof patch === 'string' || Object.keys(patch).length > 0;

  const save = (): void => {
    if (typeof patch === 'string') {
      setSaveMessage({ ok: false, text: patch });
      return;
    }
    setBusy(true);
    void sock.updateTableSettings(patch).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setSaveMessage({ ok: false, text: result.message });
        return;
      }
      setTouched(false);
      setSaveMessage({ ok: true, text: result.deferred ? 'Saved — blinds/ante/straddle switch over when this hand ends.' : 'Saved.' });
    });
  };

  const visibleSeats = state.seats.filter((s) => !state.removedSeatIds.includes(s.seatId));
  const canAddSeat = state.removedSeatIds.length > 0 || state.seats.length < 9;
  const canChangeSeat = (seat: ProjectedSeat): boolean => isAdmin || !seat.playerId;

  const runSeatAction = (seatId: number, action: 'remove' | 'delete'): void => {
    setConfirming(null);
    setSeatMessage(null);
    void (action === 'remove' ? sock.removePlayer(seatId) : sock.deleteSeat(seatId)).then((r) => {
      if (!r.ok) setSeatMessage(r.message);
    });
  };

  const pending = state.pendingSettings;
  const pendingText = pending
    ? [
        pending.smallBlind !== undefined || pending.bigBlind !== undefined
          ? `blinds ${formatChips(pending.smallBlind ?? state.settings.smallBlind)}/${formatChips(pending.bigBlind ?? state.settings.bigBlind)}`
          : null,
        pending.ante !== undefined ? `ante ${formatChips(pending.ante)}` : null,
        pending.straddleEnabled !== undefined ? `straddle ${pending.straddleEnabled ? 'on' : 'off'}` : null,
      ]
        .filter(Boolean)
        .join(', ')
    : null;

  return (
    <div className="owner-menu-backdrop" onClick={onClose}>
      <aside className="owner-menu" role="dialog" aria-label="Table controls" onClick={(e) => e.stopPropagation()}>
        <div className="owner-menu-header">
          <h3>Table controls</h3>
          <button type="button" className="owner-menu-close" aria-label="Close table controls" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="owner-menu-status">
          {inHand ? 'Hand in progress — you can still change anything below.' : 'Between hands — every change applies right away.'}
        </div>
        {pendingText && <div className="owner-menu-pending">Next hand: {pendingText}</div>}

        <section className="owner-menu-section">
          <h4>Game settings</h4>
          <TableSettingsFields
            form={form}
            set={set}
            privacyExtra={
              <>
                {state.settings.isPrivate && inviteCode && state.settings.openSeating && (
                  <p className="owner-menu-note">Open invite link — anyone with it can pick a free seat or join the waitlist:</p>
                )}
                {state.settings.isPrivate && inviteCode && (
                  <input
                    type="text"
                    className="assign-link-input"
                    readOnly
                    aria-label="Private table link"
                    value={`${window.location.origin}/table/${tableId}?code=${inviteCode}`}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                )}
              </>
            }
          />
          {inHand && <p className="owner-menu-note">Blinds, ante and straddle switch over when this hand ends. Everything else applies right away.</p>}
          {saveMessage && <div className={saveMessage.ok ? 'owner-menu-ok' : 'error-banner'}>{saveMessage.text}</div>}
          <div className="owner-menu-actions">
            <button
              type="button"
              disabled={!touched || busy}
              onClick={() => {
                setTouched(false);
                setSaveMessage(null);
                setForm(base);
              }}
            >
              Undo changes
            </button>
            <button type="button" className="btn-primary" disabled={!hasChanges || busy} onClick={save}>
              Save changes
            </button>
          </div>
        </section>

        <section className="owner-menu-section">
          <div className="owner-menu-section-title">
            <h4>Seats ({visibleSeats.length})</h4>
            <button
              type="button"
              disabled={!canAddSeat}
              onClick={() => {
                setSeatMessage(null);
                void sock.addSeat().then((r) => {
                  if (!r.ok) setSeatMessage(r.message);
                });
              }}
            >
              + Add seat
            </button>
          </div>
          {seatMessage && <div className="error-banner">{seatMessage}</div>}
          {isAdmin && sock.lastError && <div className="owner-menu-last-error">Last error: {sock.lastError.message}</div>}
          <ul className="owner-menu-seats">
            {visibleSeats.map((seat) => {
              const empty = seat.status === 'empty';
              const badges = seatBadges(seat);
              const isConfirming = confirming?.seatId === seat.seatId;
              return (
                <li key={seat.seatId} className="owner-menu-seat" data-testid={`owner-seat-${String(seat.seatId)}`}>
                  <div className="owner-menu-seat-line">
                    <span className="owner-menu-seat-id">Seat {seat.seatId}</span>
                    <span className="owner-menu-seat-who">{empty ? 'Empty' : (seat.displayName ?? 'Player')}</span>
                    {!empty && <span className="owner-menu-seat-stack">{formatChips(seat.stack)}</span>}
                  </div>
                  {badges.length > 0 && (
                    <div className="owner-menu-seat-badges">
                      {badges.map((b) => (
                        <span key={b} className="seat-tag">
                          {b}
                        </span>
                      ))}
                    </div>
                  )}
                  {isConfirming ? (
                    <div className="owner-menu-seat-actions">
                      <span className="owner-menu-confirm-text">
                        {confirming.action === 'delete' ? 'Delete this seat' : 'Remove this player'}
                        {!empty && seat.status !== 'sitting-out' && inHand ? ' after this hand' : ''}?
                      </span>
                      <button type="button" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                      <button type="button" className="btn-owner-danger" onClick={() => runSeatAction(seat.seatId, confirming.action)}>
                        Yes
                      </button>
                    </div>
                  ) : chipsFor === seat.seatId ? (
                    <div className="owner-menu-seat-actions">
                      <label className="owner-menu-chips-label">
                        Add ($)
                        <MoneyInput minCents={1} cents={chipsAmount} onChange={setChipsAmount} autoFocus />
                      </label>
                      <button type="button" onClick={() => setChipsFor(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={chipsAmount === '' || chipsAmount <= 0}
                        onClick={() => {
                          if (chipsAmount === '' || chipsAmount <= 0) return;
                          sock.adminRebuy(seat.seatId, chipsAmount);
                          setChipsFor(null);
                        }}
                      >
                        Add chips
                      </button>
                    </div>
                  ) : (
                    <div className="owner-menu-seat-actions">
                      {empty && onSitHere && (
                        <button type="button" onClick={() => onSitHere(seat.seatId)}>
                          Sit here
                        </button>
                      )}
                      {empty && (
                        <button type="button" onClick={() => onAddBot(seat.seatId)}>
                          Seat a bot
                        </button>
                      )}
                      {empty && isAdmin && (
                        <button type="button" onClick={() => onInvite(seat.seatId)}>
                          Invite player
                        </button>
                      )}
                      {!empty && isAdmin && !seat.leavingAfterHand && (
                        <button
                          type="button"
                          onClick={() => {
                            const headroom = Math.max(0, state.settings.maxBuyIn - seat.stack - seat.pendingChips);
                            setChipsAmount(headroom > 0 ? headroom : '');
                            setChipsFor(seat.seatId);
                          }}
                        >
                          Add chips
                        </button>
                      )}
                      {!empty && canChangeSeat(seat) && !seat.leavingAfterHand && (
                        <button type="button" onClick={() => setConfirming({ seatId: seat.seatId, action: 'remove' })}>
                          Remove player
                        </button>
                      )}
                      {canChangeSeat(seat) && !(seat.leavingAfterHand && !empty) && (
                        <button
                          type="button"
                          className="btn-owner-danger"
                          disabled={visibleSeats.length <= 2}
                          onClick={() => setConfirming({ seatId: seat.seatId, action: 'delete' })}
                        >
                          Delete seat
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {inHand && <p className="owner-menu-note">Players still in this hand are folded on their turn and leave when it ends; chips you add them land then too.</p>}
        </section>

        {isAdmin && accessToken && (
          <section className="owner-menu-section">
            <h4>Game report</h4>
            <p className="owner-menu-note">
              Every buy-in, rebuy and cash-out, each hand&rsquo;s results, profit/loss, rankings and who pays whom — updated after every hand
              and kept permanently.{' '}
              {completedHands > 0
                ? `Right now it covers ${String(completedHands)} hand${completedHands === 1 ? '' : 's'} (through hand #${String(completedHands)}).`
                : 'This game hasn’t finished a hand yet.'}
            </p>
            <ReportDownloads path={`/admin/tables/${tableId}/report`} accessToken={accessToken} testIdPrefix="table-report" />
          </section>
        )}

        {isAdmin && (
          <section className="owner-menu-section">
            <h4>Table</h4>
            <div className="owner-menu-actions">
              <button type="button" className="btn-owner-action" onClick={onReset}>
                Reset table
              </button>
              <button type="button" className="btn-owner-action btn-owner-danger" onClick={onTerminate}>
                Terminate table
              </button>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}

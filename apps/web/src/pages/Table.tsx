import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { API_BASE } from '../api.js';
import { useAuth } from '../AuthContext.js';
import { ActionBar } from '../components/ActionBar.js';
import { ActionLog } from '../components/ActionLog.js';
import { ActionTimer } from '../components/ActionTimer.js';
import { BoardAndPot } from '../components/BoardAndPot.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { ChipStack } from '../components/ChipStack.js';
import { DealAnimation } from '../components/DealAnimation.js';
import { Seat } from '../components/Seat.js';
import { VoicePanel } from '../components/VoicePanel.js';
import { WaitlistPanel } from '../components/WaitlistPanel.js';
import { WinCelebration } from '../components/WinCelebration.js';
import { BOT_PERSONAS } from '../botPersonas.js';
import { formatChips } from '../chips.js';
import { computePositionLabels } from '../positionLabels.js';
import { livePotTotal } from '../potTotal.js';
import { seatPositions, seatSizeVars } from '../seatLayout.js';
import { useImmersiveMode } from '../useImmersiveMode.js';
import { useSocket } from '../useSocket.js';
import { useTableSocket } from '../useTableSocket.js';
import { useVoiceChat } from '../useVoiceChat.js';

export function TablePage(): React.JSX.Element {
  const { tableId } = useParams<{ tableId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const inviteCode = searchParams.get('code') ?? undefined;
  const { user, accessToken, setDisplayName } = useAuth();
  const { socket, connected } = useSocket(accessToken);
  const sock = useTableSocket(socket);
  const voice = useVoiceChat(socket);
  const immersive = useImmersiveMode();
  const navigate = useNavigate();
  const [seatModal, setSeatModal] = useState<number | null>(null);
  const [buyIn, setBuyIn] = useState(0);
  const [seatDisplayName, setSeatDisplayName] = useState('');
  const [rebuyModal, setRebuyModal] = useState<number | null>(null);
  const [rebuyAmount, setRebuyAmount] = useState(0);
  const [bottomTab, setBottomTab] = useState<'chat' | 'log'>('chat');
  const [addBotModal, setAddBotModal] = useState<number | null>(null);
  const [botPersona, setBotPersona] = useState(BOT_PERSONAS[0]!.id);
  const [botBuyIn, setBotBuyIn] = useState(0);
  const [terminateConfirmOpen, setTerminateConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [assignModal, setAssignModal] = useState<number | null>(null);
  const [assignBuyIn, setAssignBuyIn] = useState(0);
  const [assignNickname, setAssignNickname] = useState('');
  const [assignedLink, setAssignedLink] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const assignToken = searchParams.get('assign');
  const [redeemedTokens, setRedeemedTokens] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (connected && tableId) sock.joinTable(tableId, inviteCode);
  }, [connected, tableId, inviteCode]);

  // Opening an owner-generated invite link (?assign=<token>) seats the
  // viewer directly, with no buy-in prompt — the amount is baked into the
  // link itself (see DECISIONS.md). Guarded against re-firing on every
  // render (the query param sticks around until the URL is cleaned up
  // below) and against a page that's already seated.
  useEffect(() => {
    if (!assignToken || !connected || redeemedTokens.has(assignToken)) return;
    if (sock.state?.viewerSeatId !== null) return;
    setRedeemedTokens((prev) => new Set(prev).add(assignToken));
    sock.redeemSeatAssignment(assignToken);
    // The token is single-use regardless of outcome, so the URL is
    // cleaned up right away rather than waiting on a result — a page
    // refresh shouldn't carry a now-dead token in the address bar.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('assign');
        return next;
      },
      { replace: true },
    );
  }, [assignToken, connected, sock.state?.viewerSeatId, redeemedTokens, setSearchParams]);

  // The table closed out from under us — an owner's "Terminate table," or
  // (for a spectator who happened to be watching) the last human leaving.
  // Nothing more to do here but head back to the lobby.
  useEffect(() => {
    if (sock.tableClosedReason) void navigate('/lobby');
  }, [sock.tableClosedReason, navigate]);

  if (!user) {
    return <div className="page-centered">Sign in to view this table.</div>;
  }
  if (sock.lastError?.code === 'INVALID_INVITE_CODE') {
    return (
      <div className="page-centered">
        <div className="auth-card">
          <h3>This table is private</h3>
          <p>{sock.lastError.message}</p>
          <Link to="/lobby">&larr; Back to lobby</Link>
        </div>
      </div>
    );
  }
  if (!sock.state) {
    return <div className="page-centered">Connecting to table...</div>;
  }

  const { state } = sock;
  const mySeat = state.viewerSeatId !== null ? state.seats.find((s) => s.seatId === state.viewerSeatId) : null;
  const positions = seatPositions(state.settings.maxSeats, state.viewerSeatId ?? 0);
  const hasEmptySeat = state.seats.some((s) => s.status === 'empty');
  const positionLabels = computePositionLabels(state.seats, state.buttonSeat);
  const myWaitlistIndex = state.waitlist.findIndex((w) => w.userId === user.id);
  // Nothing about a hand's structure (dealer button, position labels, hole
  // cards) should show before this table's very first deal — it only
  // becomes true once a hand has actually started at least once.
  const handEverDealt = state.phase !== 'waiting';

  const voiceStreamForSeat = (seat: (typeof state.seats)[number]): { stream: MediaStream; isLocal: boolean } | null => {
    if (voice.inCall && seat.seatId === state.viewerSeatId && voice.localStream) {
      return { stream: voice.localStream, isLocal: true };
    }
    if (seat.playerId) {
      const peer = voice.peers.find((p) => p.userId === seat.playerId);
      if (peer?.stream) return { stream: peer.stream, isLocal: false };
    }
    return null;
  };
  // Voice participants with no seat at this table (spectators using voice chat) —
  // shown in the compact VoicePanel strip instead, since there's no seat to render them on.
  const unseatedVoicePeers = voice.peers.filter((p) => !state.seats.some((s) => s.playerId === p.userId));

  const openSeatModal = (seatId: number): void => {
    setBuyIn(state.settings.minBuyIn);
    setSeatDisplayName(user.displayName);
    setSeatModal(seatId);
  };

  const confirmTakeSeat = (): void => {
    if (seatModal === null || !tableId) return;
    const trimmedName = seatDisplayName.trim();
    const renamed = trimmedName.length > 0 && trimmedName !== user.displayName;
    sock.takeSeat(tableId, seatModal, buyIn, renamed ? trimmedName : undefined);
    if (renamed) setDisplayName(trimmedName);
    setSeatModal(null);
  };

  const openAddBotModal = (seatId: number): void => {
    setBotPersona(BOT_PERSONAS[0]!.id);
    setBotBuyIn(state.settings.minBuyIn);
    setAddBotModal(seatId);
  };

  const confirmAddBot = (): void => {
    if (addBotModal === null) return;
    sock.addBot(addBotModal, botPersona, botBuyIn);
    setAddBotModal(null);
  };

  const openAssignModal = (seatId: number): void => {
    setAssignBuyIn(state.settings.minBuyIn);
    setAssignNickname('');
    setAssignedLink(null);
    setAssignError(null);
    setAssignModal(seatId);
  };

  const confirmAssignSeat = (): void => {
    if (assignModal === null) return;
    setAssignError(null);
    void sock.assignSeat(assignModal, assignBuyIn, assignNickname.trim() || undefined).then((result) => {
      if (!result.ok) {
        setAssignError(result.message);
        return;
      }
      setAssignedLink(`${window.location.origin}/table/${String(tableId)}?assign=${result.token}`);
    });
  };

  const openRebuyModal = (seatId: number, currentStack: number): void => {
    setRebuyAmount(state.settings.maxBuyIn - currentStack);
    setRebuyModal(seatId);
  };

  return (
    <div className={`table-page${immersive.active ? ' immersive' : ''}`}>
      <div className="table-header">
        <Link to="/lobby">&larr; Lobby</Link>
        <div className="table-header-name">
          {state.tableName}
          {state.settings.isPrivate && <span className="seat-tag">private</span>}
        </div>
        <div className="table-header-right">
          {!mySeat && myWaitlistIndex === 0 && hasEmptySeat && <span className="seat-tag seat-tag-allin">A seat is open!</span>}
          {mySeat && (
            <button
              type="button"
              onClick={() => {
                void sock.leaveTable().then(() => navigate('/lobby'));
              }}
            >
              Leave table
            </button>
          )}
          {user.role === 'admin' && (
            <>
              <button type="button" className="btn-owner-action" onClick={() => setResetConfirmOpen(true)}>
                Reset table
              </button>
              <button type="button" className="btn-owner-action btn-owner-danger" onClick={() => setTerminateConfirmOpen(true)}>
                Terminate table
              </button>
            </>
          )}
          {mySeat && mySeat.status === 'sitting-out' && (
            <button type="button" onClick={() => sock.sitIn()}>
              Sit in
            </button>
          )}
          {mySeat && mySeat.status !== 'sitting-out' && (
            <button type="button" onClick={() => sock.sitOut()}>
              Sit out next hand
            </button>
          )}
        </div>
      </div>

      <VoicePanel voice={voice} myName={user.displayName} amSeated={!!mySeat} unseatedPeers={unseatedVoicePeers} />

      <WaitlistPanel
        waitlist={state.waitlist}
        myUserId={user.id}
        canJoin={!mySeat}
        onJoin={() => sock.joinWaitlist()}
        onLeave={() => sock.leaveWaitlist()}
      />

      <div className="felt" style={seatSizeVars(state.settings.maxSeats)}>
        <BoardAndPot board={state.board} pots={state.pots} liveTotal={livePotTotal(state)} />
        {state.handCommitment && (
          <div className="fairness-commitment" data-testid="fairness-commitment" title={state.handCommitment}>
            Fairness commitment: {state.handCommitment.slice(0, 12)}&hellip;
          </div>
        )}
        {state.phase === 'hand-complete' && state.handId && (
          <a className="fairness-link" href={`${API_BASE}/fairness/${state.handId}`} target="_blank" rel="noreferrer">
            Verify hand fairness
          </a>
        )}
        {/* Always mounted — ActionTimer.tsx handles `deadline === null` itself
            (fades out via CSS opacity, ticks nothing). Wrapping this in
            `actingSeat !== null &&` here would unmount/remount the whole
            component on every transition through a null actingSeat (a bot's
            turn, or the brief gap between one action resolving and the next
            actor being assigned), reproducing exactly the remount-flash bug
            ActionTimer.tsx's own fix was written to eliminate — see its
            doc comment and DECISIONS.md. */}
        <ActionTimer deadline={state.actionDeadline} totalSeconds={state.settings.actionSeconds} />
        <button
          type="button"
          className="immersive-toggle"
          onClick={immersive.toggle}
          title={immersive.active ? 'Show the rest of the page' : 'Hide the rest of the page while playing'}
        >
          {immersive.active ? '⤡ Exit full screen' : '⛶ Full screen'}
        </button>
        <DealAnimation events={sock.latestEvents} positions={positions} />
        <WinCelebration events={sock.latestEvents} positions={positions} viewerSeatId={state.viewerSeatId} />
        {state.phase !== 'in-hand' && (
          <div className="start-hand-panel">
            {mySeat ? (
              <>
                <button type="button" className="btn-start-hand" disabled={!state.canStartHand} onClick={() => sock.startHand()}>
                  Play Hand
                </button>
                {!state.canStartHand && (
                  <span className="start-hand-hint">Waiting for at least 2 seated players&hellip;</span>
                )}
              </>
            ) : (
              <span className="start-hand-hint">Waiting for a seated player to start a hand&hellip;</span>
            )}
          </div>
        )}
        {positions.map(({ seatId, left, top, betLeft, betTop }) => {
          const seat = state.seats.find((s) => s.seatId === seatId);
          if (!seat) return null;
          return (
            <Fragment key={seatId}>
              <div
                className="seat-slot"
                data-testid={`seat-${String(seatId)}`}
                data-seat-status={seat.status}
                style={{ left: `${String(left)}%`, top: `${String(top)}%` }}
              >
                <Seat
                  seat={seat}
                  isButton={handEverDealt && state.buttonSeat === seatId}
                  isActing={state.betting.actingSeat === seatId}
                  isViewer={state.viewerSeatId === seatId}
                  positionLabel={handEverDealt ? positionLabels.get(seatId) : undefined}
                  showCards={handEverDealt}
                  voice={voiceStreamForSeat(seat)}
                  // Self-serve seating/bots/rebuys no longer exist — every one of these is owner-only. See DECISIONS.md.
                  onEmptySeatClick={user.role === 'admin' && !mySeat && seat.status === 'empty' ? () => openSeatModal(seatId) : undefined}
                  onAddBotClick={user.role === 'admin' && seat.status === 'empty' ? () => openAddBotModal(seatId) : undefined}
                  onAssignHumanClick={user.role === 'admin' && seat.status === 'empty' ? () => openAssignModal(seatId) : undefined}
                  onRemoveBotClick={seat.isBot ? () => sock.removeBot(seatId) : undefined}
                  onRebuyClick={
                    user.role === 'admin' && !seat.isBot && seat.status !== 'empty' ? () => openRebuyModal(seatId, seat.stack) : undefined
                  }
                />
              </div>
              {seat.status !== 'empty' && seat.committedThisStreet > 0 && (
                <div
                  className="bet-chips-slot"
                  data-testid={`bet-chips-${String(seatId)}`}
                  style={{ left: `${String(betLeft)}%`, top: `${String(betTop)}%` }}
                >
                  <ChipStack amount={seat.committedThisStreet} />
                </div>
              )}
            </Fragment>
          );
        })}
      </div>

      {state.legalActions && (
        <ActionBar
          legalActions={state.legalActions}
          potSize={livePotTotal(state)}
          bigBlind={state.settings.bigBlind}
          onAction={(type, amountTo) => {
            if (!state.handId) return;
            sock.submitAction(state.handId, state.actionSeq, type, amountTo);
          }}
        />
      )}

      {sock.lastError && sock.lastError.code !== 'INVALID_INVITE_CODE' && <div className="error-banner">{sock.lastError.message}</div>}

      <div className="bottom-tabs">
        <button type="button" className={bottomTab === 'chat' ? 'active' : ''} onClick={() => setBottomTab('chat')}>
          Chat
        </button>
        <button type="button" className={bottomTab === 'log' ? 'active' : ''} onClick={() => setBottomTab('log')}>
          Hand log
        </button>
      </div>
      {bottomTab === 'chat' ? (
        <ChatPanel messages={sock.chat} onSend={sock.sendChat} />
      ) : (
        <ActionLog events={sock.recentEvents} seats={state.seats} />
      )}

      {seatModal !== null && (
        <div className="modal-backdrop" onClick={() => setSeatModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Take seat {seatModal}</h3>
            <label>
              Display name
              <input type="text" maxLength={24} value={seatDisplayName} onChange={(e) => setSeatDisplayName(e.target.value)} />
            </label>
            <label>
              Buy-in ({formatChips(state.settings.minBuyIn)} &ndash; {formatChips(state.settings.maxBuyIn)})
              <input
                type="number"
                min={state.settings.minBuyIn}
                max={state.settings.maxBuyIn}
                value={buyIn}
                onChange={(e) => setBuyIn(Number(e.target.value))}
              />
            </label>
            <p>Your chips: {formatChips(user.chips)}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setSeatModal(null)}>
                Cancel
              </button>
              <button type="button" onClick={confirmTakeSeat}>
                Sit down
              </button>
            </div>
          </div>
        </div>
      )}

      {addBotModal !== null && (
        <div className="modal-backdrop" onClick={() => setAddBotModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add a computer player</h3>
            <p>For fun — not a real account, chips aren&rsquo;t drawn from anyone&rsquo;s balance.</p>
            <label>
              Persona
              <select value={botPersona} onChange={(e) => setBotPersona(e.target.value)}>
                {BOT_PERSONAS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} &mdash; {p.description}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Buy-in ({formatChips(state.settings.minBuyIn)} &ndash; {formatChips(state.settings.maxBuyIn)})
              <input
                type="number"
                min={state.settings.minBuyIn}
                max={state.settings.maxBuyIn}
                value={botBuyIn}
                onChange={(e) => setBotBuyIn(Number(e.target.value))}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setAddBotModal(null)}>
                Cancel
              </button>
              <button type="button" onClick={confirmAddBot}>
                Add bot
              </button>
            </div>
          </div>
        </div>
      )}

      {rebuyModal !== null && (
        <div className="modal-backdrop" onClick={() => setRebuyModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Rebuy seat {rebuyModal}</h3>
            <p>Owner-only — debits this player&rsquo;s own chip balance, same as a normal buy-in.</p>
            <label>
              Amount
              <input
                type="number"
                min={1}
                value={rebuyAmount}
                onChange={(e) => setRebuyAmount(Number(e.target.value))}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setRebuyModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  sock.adminRebuy(rebuyModal, rebuyAmount);
                  setRebuyModal(null);
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {assignModal !== null && (
        <div className="modal-backdrop" onClick={() => setAssignModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Assign a human to seat {assignModal}</h3>
            {!assignedLink ? (
              <>
                <p>Generates a one-time link — whoever opens it is seated here with exactly this buy-in, no prompt shown to them.</p>
                <label>
                  Nickname (only visible to you)
                  <input
                    type="text"
                    maxLength={40}
                    placeholder="e.g. Dave from work"
                    value={assignNickname}
                    onChange={(e) => setAssignNickname(e.target.value)}
                  />
                </label>
                <label>
                  Buy-in ({formatChips(state.settings.minBuyIn)} &ndash; {formatChips(state.settings.maxBuyIn)})
                  <input
                    type="number"
                    min={state.settings.minBuyIn}
                    max={state.settings.maxBuyIn}
                    value={assignBuyIn}
                    onChange={(e) => setAssignBuyIn(Number(e.target.value))}
                  />
                </label>
                {assignError && <div className="error-banner">{assignError}</div>}
                <div className="modal-actions">
                  <button type="button" onClick={() => setAssignModal(null)}>
                    Cancel
                  </button>
                  <button type="button" onClick={confirmAssignSeat}>
                    Generate link
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Send this link to the person you want in seat {assignModal}:</p>
                <input
                  type="text"
                  className="assign-link-input"
                  readOnly
                  value={assignedLink}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="modal-actions">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(assignedLink);
                    }}
                  >
                    Copy link
                  </button>
                  <button type="button" onClick={() => setAssignModal(null)}>
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {terminateConfirmOpen && (
        <div className="modal-backdrop" onClick={() => setTerminateConfirmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Terminate this table?</h3>
            <p>
              This ends the table for everyone right now, refunds every seated human&rsquo;s current stack, and cannot be undone.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setTerminateConfirmOpen(false)}>
                No, keep it running
              </button>
              <button
                type="button"
                className="btn-owner-danger"
                onClick={() => {
                  setTerminateConfirmOpen(false);
                  void sock.terminateTable();
                }}
              >
                Yes, terminate
              </button>
            </div>
          </div>
        </div>
      )}

      {resetConfirmOpen && (
        <div className="modal-backdrop" onClick={() => setResetConfirmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset this table?</h3>
            <p>
              This empties every seat and refunds every seated human&rsquo;s current stack, but the table itself stays &mdash;
              same name, same settings, same link.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setResetConfirmOpen(false)}>
                No, leave it as is
              </button>
              <button
                type="button"
                className="btn-owner-danger"
                onClick={() => {
                  setResetConfirmOpen(false);
                  void sock.resetTable();
                }}
              >
                Yes, reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

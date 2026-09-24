import { Fragment, useEffect, useMemo, useState } from 'react';
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
import { HandBreakPanel } from '../components/HandBreakPanel.js';
import { Seat } from '../components/Seat.js';
import { SpeakerBar, type SpeakerBarTile } from '../components/SpeakerBar.js';
import { VoicePanel } from '../components/VoicePanel.js';
import { WaitlistPanel } from '../components/WaitlistPanel.js';
import { WinCelebration } from '../components/WinCelebration.js';
import { BOT_PERSONAS } from '../botPersonas.js';
import { formatChips } from '../chips.js';
import { computePositionLabels } from '../positionLabels.js';
import { livePotTotal } from '../potTotal.js';
import { seatPositions, seatSizeVars } from '../seatLayout.js';
import { useActiveSpeakers } from '../useActiveSpeakers.js';
import { useImmersiveMode } from '../useImmersiveMode.js';
import { useIsCompactScreen } from '../useIsCompactScreen.js';
import { useSocket } from '../useSocket.js';
import { useTableSocket } from '../useTableSocket.js';
import { useVoiceChat } from '../useVoiceChat.js';

/**
 * Chooses who fills the (at most 2) collapsed speaker-bar tiles: the
 * currently-active speakers first (already most-recent-first), then
 * backfilled in ascending seat order so the bar never sits empty right
 * when the 5th camera turns on, before anyone's spoken yet.
 */
function pickSpeakerTiles(
  seats: { seatId: number; displayName: string; stream: MediaStream; isLocal: boolean }[],
  activeSpeakerIds: string[],
): SpeakerBarTile[] {
  const bySeatId = new Map(seats.map((s) => [String(s.seatId), s]));
  const chosen: string[] = [];
  for (const id of activeSpeakerIds) {
    if (chosen.length >= 2) break;
    if (bySeatId.has(id) && !chosen.includes(id)) chosen.push(id);
  }
  for (const s of seats) {
    if (chosen.length >= 2) break;
    const id = String(s.seatId);
    if (!chosen.includes(id)) chosen.push(id);
  }
  return chosen.map((id) => {
    const s = bySeatId.get(id)!;
    return { id, stream: s.stream, isLocal: s.isLocal, label: s.displayName };
  });
}

export function TablePage(): React.JSX.Element {
  const { tableId } = useParams<{ tableId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const inviteCode = searchParams.get('code') ?? undefined;
  const { user, accessToken, setDisplayName } = useAuth();
  const { socket, connected } = useSocket(accessToken);
  const sock = useTableSocket(socket);
  const voice = useVoiceChat(socket);
  const immersive = useImmersiveMode();
  const isCompactScreen = useIsCompactScreen();
  const navigate = useNavigate();
  const [seatModal, setSeatModal] = useState<number | null>(null);
  // '' is a real intermediate state (the field cleared, not yet retyped) —
  // coercing an empty string straight to 0 made the DOM input's value jump
  // to "0" mid-edit, so retyping "500" over a cleared "500" produced "0500".
  const [buyIn, setBuyIn] = useState<number | ''>(0);
  const [seatDisplayName, setSeatDisplayName] = useState('');
  const [rebuyModal, setRebuyModal] = useState<number | null>(null);
  const [rebuyAmount, setRebuyAmount] = useState(0);
  const [bottomTab, setBottomTab] = useState<'chat' | 'log'>('chat');
  const [addBotModal, setAddBotModal] = useState<number | null>(null);
  const [botPersona, setBotPersona] = useState(BOT_PERSONAS[0]!.id);
  // Each persona actually added sinks to the bottom of the list — so
  // picking a DIFFERENT bot for the next seat is the path of least
  // resistance instead of re-selecting the same one repeatedly.
  const [usedPersonaOrder, setUsedPersonaOrder] = useState<string[]>([]);
  const orderedBotPersonas = useMemo(() => {
    const usedSet = new Set(usedPersonaOrder);
    const unused = BOT_PERSONAS.filter((p) => !usedSet.has(p.id));
    const used = usedPersonaOrder.map((id) => BOT_PERSONAS.find((p) => p.id === id)).filter((p): p is (typeof BOT_PERSONAS)[number] => !!p);
    return [...unused, ...used];
  }, [usedPersonaOrder]);
  const [botBuyIn, setBotBuyIn] = useState<number | ''>(0);
  const [terminateConfirmOpen, setTerminateConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [assignModal, setAssignModal] = useState<number | null>(null);
  const [assignBuyIn, setAssignBuyIn] = useState<number | ''>(0);
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

  // Memoized deliberately: DealAnimation.tsx's shuffle/deal effect depends
  // on `[events, positions]`, and `latestEvents` never resets back to []
  // once consumed — so a fresh `positions` array reference on every
  // render (any state change at all, e.g. toggling immersive mode) used
  // to retrigger that effect with the stale-but-still-truthy last events
  // batch, replaying the shuffle/deal animation and sound out of nowhere.
  // See DECISIONS.md.
  //
  // MUST live above every early return below (`sock.state` is still null
  // before the table's first 'state' event arrives) — hooks can never be
  // called conditionally, and a `useMemo` after an early return is exactly
  // that: it ran on some renders and not others, which is a real crash
  // ("Rendered more hooks than during the previous render"), not just a
  // lint nitpick. Found by actually loading the page in a browser, not by
  // tsc/eslint — neither one catches this.
  const positions = useMemo(
    () => (sock.state ? seatPositions(sock.state.settings.maxSeats, sock.state.viewerSeatId ?? 0) : []),
    [sock.state?.settings.maxSeats, sock.state?.viewerSeatId],
  );

  // Same hook-ordering constraint as `positions` above — sock.state can be
  // null pre-connect, so this duplicates voiceStreamForSeat's (further
  // below, where `state` is guaranteed non-null) stream-resolution logic
  // in a form that tolerates that.
  const humanCameraSeats: { seatId: number; displayName: string; stream: MediaStream; isLocal: boolean }[] = [];
  for (const seat of sock.state?.seats ?? []) {
    if (seat.status === 'empty' || seat.isBot) continue;
    let stream: MediaStream | null = null;
    let isLocal = false;
    if (voice.inCall && seat.seatId === sock.state?.viewerSeatId && voice.localStream) {
      stream = voice.localStream;
      isLocal = true;
    } else if (seat.playerId) {
      stream = voice.peers.find((p) => p.userId === seat.playerId)?.stream ?? null;
    }
    if (stream && stream.getVideoTracks().length > 0) {
      humanCameraSeats.push({ seatId: seat.seatId, displayName: seat.displayName ?? 'Player', stream, isLocal });
    }
  }

  // More than 4 human players on camera, collapsed only on a phone-sized
  // screen — laptops/tablets keep full per-seat video regardless of count.
  // See useIsCompactScreen.ts and useActiveSpeakers.ts.
  const speakerBarActive = isCompactScreen && humanCameraSeats.length > 4;
  const activeSpeakerIds = useActiveSpeakers(
    humanCameraSeats.map((s) => ({ id: String(s.seatId), stream: s.stream })),
    speakerBarActive,
  );
  // On a phone, 1-4 human cameras have enough felt space to run noticeably
  // (~20%) bigger tiles than the baseline per-seat-count sizing gives them —
  // more than 4 already collapses into the speaker bar above instead of
  // shrinking per-seat video further, so boosting past that count would
  // just fight the collapse and crowd the felt/cards. See .felt-video-boost.
  const videoBoostActive = isCompactScreen && humanCameraSeats.length >= 1 && humanCameraSeats.length <= 4;

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
  const speakerTiles = speakerBarActive ? pickSpeakerTiles(humanCameraSeats, activeSpeakerIds) : [];
  // Voice participants with no seat at this table (spectators using voice chat) —
  // shown in the compact VoicePanel strip instead, since there's no seat to
  // render them on. Every human at the table is now a registered `voice.peers`
  // entry the moment they arrive (see useVoiceChat.ts's own doc comment), so
  // this ALSO requires a real stream — otherwise every silent spectator who's
  // never touched voice at all would show up here as an empty avatar tile.
  const unseatedVoicePeers = voice.peers.filter((p) => p.stream !== null && !state.seats.some((s) => s.playerId === p.userId));

  const openSeatModal = (seatId: number): void => {
    setBuyIn(state.settings.minBuyIn);
    setSeatDisplayName(user.displayName);
    setSeatModal(seatId);
  };

  const confirmTakeSeat = (): void => {
    if (seatModal === null || !tableId) return;
    const trimmedName = seatDisplayName.trim();
    const renamed = trimmedName.length > 0 && trimmedName !== user.displayName;
    sock.takeSeat(tableId, seatModal, Number(buyIn) || 0, renamed ? trimmedName : undefined);
    if (renamed) setDisplayName(trimmedName);
    setSeatModal(null);
  };

  const openAddBotModal = (seatId: number): void => {
    setBotPersona(orderedBotPersonas[0]!.id);
    setBotBuyIn(state.settings.minBuyIn);
    setAddBotModal(seatId);
  };

  const confirmAddBot = (): void => {
    if (addBotModal === null) return;
    sock.addBot(addBotModal, botPersona, Number(botBuyIn) || 0);
    setUsedPersonaOrder((prev) => [...prev.filter((id) => id !== botPersona), botPersona]);
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
    void sock.assignSeat(assignModal, Number(assignBuyIn) || 0, assignNickname.trim() || undefined).then((result) => {
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
      {speakerBarActive && <SpeakerBar tiles={speakerTiles} />}

      <WaitlistPanel
        waitlist={state.waitlist}
        myUserId={user.id}
        canJoin={!mySeat}
        onJoin={() => sock.joinWaitlist()}
        onLeave={() => sock.leaveWaitlist()}
      />

      <div className={`felt${videoBoostActive ? ' felt-video-boost' : ''}`} style={seatSizeVars(state.settings.maxSeats)}>
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
          <HandBreakPanel
            nextHandAt={state.nextHandAt}
            canStartHand={state.canStartHand}
            amSeated={!!mySeat}
            onStartHand={() => sock.startHand()}
          />
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
                  showVideo={!speakerBarActive}
                  // Self-serve seating/bots/rebuys no longer exist — every one of these is owner-only. See DECISIONS.md.
                  onEmptySeatClick={user.role === 'admin' && !mySeat && seat.status === 'empty' ? () => openSeatModal(seatId) : undefined}
                  onAddBotClick={user.role === 'admin' && seat.status === 'empty' ? () => openAddBotModal(seatId) : undefined}
                  onAssignHumanClick={user.role === 'admin' && seat.status === 'empty' ? () => openAssignModal(seatId) : undefined}
                  onRemoveBotClick={seat.isBot ? () => sock.removeBot(seatId) : undefined}
                  // Hidden in full screen / immersive mode — it renders as a
                  // corner overlay on the seat's video tile, which in
                  // immersive mode is the player's whole visible camera and
                  // the button ends up covering their face. Exiting full
                  // screen brings it back; the owner can still rebuy anyone
                  // that way. See DECISIONS.md.
                  onRebuyClick={
                    user.role === 'admin' && !seat.isBot && seat.status !== 'empty' && !immersive.active
                      ? () => openRebuyModal(seatId, seat.stack)
                      : undefined
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
                onChange={(e) => setBuyIn(e.target.value === '' ? '' : Number(e.target.value))}
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
                {orderedBotPersonas.map((p) => (
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
                onChange={(e) => setBotBuyIn(e.target.value === '' ? '' : Number(e.target.value))}
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
                    onChange={(e) => setAssignBuyIn(e.target.value === '' ? '' : Number(e.target.value))}
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

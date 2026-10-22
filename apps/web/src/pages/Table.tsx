import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import { MoneyInput } from '../components/MoneyInput.js';
import { OwnerMenu } from '../components/OwnerMenu.js';
import { RevealHandButton } from '../components/RevealHandButton.js';
import { Seat } from '../components/Seat.js';
import { SpeakerBar, type SpeakerBarTile } from '../components/SpeakerBar.js';
import { VoicePanel } from '../components/VoicePanel.js';
import { WaitlistPanel } from '../components/WaitlistPanel.js';
import { WinCelebration } from '../components/WinCelebration.js';
import { BOT_PERSONAS } from '../botPersonas.js';
import { formatChips } from '../chips.js';
import { isBluffHand } from '../handStrength.js';
import { computePositionLabels } from '../positionLabels.js';
import { livePotTotal } from '../potTotal.js';
import { seatPositionsFor, seatSizeVars } from '../seatLayout.js';
import { useActiveSpeakers } from '../useActiveSpeakers.js';
import { useCameraFit } from '../useCameraFit.js';
import { useImmersiveMode } from '../useImmersiveMode.js';
import { useIsCompactScreen } from '../useIsCompactScreen.js';
import { useJustRevealedSeats } from '../useJustRevealedSeats.js';
import { useSocket } from '../useSocket.js';
import { useTableSocket } from '../useTableSocket.js';
import { useVoiceChat } from '../useVoiceChat.js';

/**
 * Chooses which seats' cameras stay visible once the table has collapsed
 * (more than 4 cameras on a phone): the currently-active speakers first
 * (already most-recent-first), then backfilled in ascending seat order so
 * the view never sits empty right when the 5th camera turns on, before
 * anyone's spoken yet. `limit` is 2 for the speaker bar; immersive mode
 * uses the full ordering as its keep-priority — see useCameraFit.ts.
 */
function pickSpeakerSeatIds(seats: { seatId: number }[], activeSpeakerIds: string[], limit: number): string[] {
  const seatIds = new Set(seats.map((s) => String(s.seatId)));
  const chosen: string[] = [];
  for (const id of activeSpeakerIds) {
    if (chosen.length >= limit) break;
    if (seatIds.has(id) && !chosen.includes(id)) chosen.push(id);
  }
  for (const s of seats) {
    if (chosen.length >= limit) break;
    const id = String(s.seatId);
    if (!chosen.includes(id)) chosen.push(id);
  }
  return chosen;
}

function pickSpeakerTiles(
  seats: { seatId: number; displayName: string; stream: MediaStream; isLocal: boolean }[],
  activeSpeakerIds: string[],
): SpeakerBarTile[] {
  const bySeatId = new Map(seats.map((s) => [String(s.seatId), s]));
  return pickSpeakerSeatIds(seats, activeSpeakerIds, 2).map((id) => {
    const s = bySeatId.get(id)!;
    return { id, stream: s.stream, isLocal: s.isLocal, label: s.displayName };
  });
}

export function TablePage(): React.JSX.Element {
  const { tableId } = useParams<{ tableId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const inviteCode = searchParams.get('code') ?? undefined;
  const { user, accessToken, setDisplayName, logout } = useAuth();
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
  const [rebuyAmount, setRebuyAmount] = useState<number | ''>(0);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  // The full-screen toggle pulses until this viewer has used it once —
  // remembered per browser, so a returning player isn't nagged. Storage can
  // be unavailable (private mode, blocked site data): then it just pulses.
  const [fullScreenDiscovered, setFullScreenDiscovered] = useState(() => {
    try {
      return window.localStorage.getItem('pokerclause.fullScreenUsed') === '1';
    } catch {
      return false;
    }
  });
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
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  // Set only by a guest's own confirmed "Leave table" click — see the
  // tableClosedReason effect below for why this exists.
  const leavingIntentionallyRef = useRef(false);
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
  // (for a spectator who happened to be watching, or any other viewer,
  // guest or not) the last human leaving. Unaffected by any of the
  // guest-specific leave-table handling below: this fires for EVERYONE
  // still watching a table that closes for a reason that had nothing to
  // do with their own choice, so it always heads back to the lobby, same
  // as it always has. `leavingIntentionallyRef` (set only by a guest's own
  // "Yes, leave" click, just below) suppresses this specific effect for
  // that one case, since a guest who was the table's last human leaving
  // makes this fire too — racing the explicit /left navigation their own
  // click already triggers.
  useEffect(() => {
    if (sock.tableClosedReason && !leavingIntentionallyRef.current) void navigate('/lobby');
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
  // Over the VISIBLE seats only — an owner-deleted seat is hidden, not
  // renumbered (see ProjectedTableState.removedSeatIds), so the ids aren't
  // always 0..n-1. Keyed on a string so it stays referentially stable
  // across state updates that don't change the layout (see above).
  const visibleSeatKey = sock.state
    ? sock.state.seats
        .map((s) => s.seatId)
        .filter((id) => !sock.state!.removedSeatIds.includes(id))
        .join(',')
    : '';
  const positions = useMemo(
    () =>
      visibleSeatKey === ''
        ? []
        : seatPositionsFor(
            visibleSeatKey.split(',').map(Number),
            sock.state?.viewerSeatId ?? null,
          ),
    [visibleSeatKey, sock.state?.viewerSeatId],
  );

  // Same hook-ordering constraint as `positions` above — sock.state can be
  // null pre-connect, so this duplicates voiceStreamForSeat's (further
  // below, where `state` is guaranteed non-null) stream-resolution logic
  // in a form that tolerates that.
  // Everyone hears the table without joining the call; seeing other
  // players' cameras is for whoever has joined it, plus the owner, who can
  // watch any table's cameras without having to turn on their own.
  const canSeeVideo = voice.inCall || user?.role === 'admin';
  const humanCameraSeats: { seatId: number; displayName: string; stream: MediaStream; isLocal: boolean }[] = [];
  for (const seat of canSeeVideo ? (sock.state?.seats ?? []) : []) {
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
  // In immersive mode the speaker bar is hidden; instead every seat keeps
  // its own video except any whose tile would collide with something (see
  // useCameraFit.ts). When a collision forces a choice, the viewer's own
  // camera wins (so they can always see themselves), then active speakers.
  const feltRef = useRef<HTMLDivElement>(null);
  const immersiveCameraFitActive = speakerBarActive && immersive.active;
  const cameraPriority = pickSpeakerSeatIds(
    humanCameraSeats,
    [...humanCameraSeats.filter((s) => s.isLocal).map((s) => String(s.seatId)), ...activeSpeakerIds],
    humanCameraSeats.length,
  );
  const immersiveHiddenCameraSeatIds = useCameraFit(feltRef, immersiveCameraFitActive, cameraPriority, sock.state?.handId ?? null);
  // On a phone, 1-3 human cameras have enough felt space to run noticeably
  // (~20%) bigger tiles than the baseline per-seat-count sizing gives them.
  // Deliberately NOT extended to exactly 4 (the highest count that still
  // shows individual video at all — more than that collapses into the
  // speaker bar instead): a boosted tile at 4 cameras is big enough to
  // visually overlap the board/pot and the fairness-commitment banner on
  // a real phone width, found by actually screenshotting that exact
  // scenario, not by tsc/eslint. See .felt-video-boost.
  const videoBoostActive = isCompactScreen && humanCameraSeats.length >= 1 && humanCameraSeats.length <= 3;

  // Same hook-ordering constraint as `positions`/`humanCameraSeats` above —
  // sock.state can be null pre-connect.
  const justRevealedSeats = useJustRevealedSeats(sock.latestEvents, sock.state?.board ?? []);

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
  // A practice-only player opening someone else's table (an old link, an
  // invite), or anyone opening a practice table that's closed or not theirs.
  if (!sock.state && (sock.lastError?.code === 'PRACTICE_ONLY' || sock.lastError?.code === 'TABLE_NOT_FOUND')) {
    return (
      <div className="page-centered">
        <div className="auth-card">
          <h3>{sock.lastError.code === 'PRACTICE_ONLY' ? 'Not available' : 'Table not found'}</h3>
          <p>{sock.lastError.code === 'PRACTICE_ONLY' ? sock.lastError.message : 'This table has closed.'}</p>
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
  // Only the seat that actually won this way, and only until it reveals or
  // the next hand deals — see ProjectedTableState.revealEligibleSeatId.
  const revealEligible = state.viewerSeatId !== null && state.viewerSeatId === state.revealEligibleSeatId;
  const revealLabel = mySeat && isBluffHand(mySeat.holeCards, state.board) ? 'Show Bluff' : 'Reveal Hand';
  const canManage = user.role === 'admin' || sock.canManageTable;
  // The table menu (seats, settings, invites) — never a practice table's own player, who only swaps bots in and out.
  const canManageLayout = user.role === 'admin' || sock.canManageLayout;
  const pendingBlinds = state.pendingSettings;
  const pendingNotice = pendingBlinds
    ? [
        pendingBlinds.smallBlind !== undefined || pendingBlinds.bigBlind !== undefined
          ? `blinds go to ${formatChips(pendingBlinds.smallBlind ?? state.settings.smallBlind)}/${formatChips(pendingBlinds.bigBlind ?? state.settings.bigBlind)}`
          : null,
        pendingBlinds.ante !== undefined ? `ante ${pendingBlinds.ante > 0 ? formatChips(pendingBlinds.ante) : 'off'}` : null,
        pendingBlinds.straddleEnabled !== undefined ? `straddle ${pendingBlinds.straddleEnabled ? 'on' : 'off'}` : null,
      ]
        .filter(Boolean)
        .join(', ')
    : null;

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

  const openRebuyModal = (seatId: number, currentStack: number, pendingChips = 0): void => {
    setRebuyAmount(Math.max(0, state.settings.maxBuyIn - currentStack - pendingChips));
    setRebuyModal(seatId);
  };

  return (
    <div className={`table-page${immersive.active ? ' immersive' : ''}`}>
      <div className="table-header">
        {/* Any real account (admin or a signed-in non-guest human) has a
            lobby to go back to — an invited GUEST doesn't (self-serve
            seating doesn't exist for them; the only way back in is a
            fresh invite link from the owner). See the leave-table
            confirm modal below and DECISIONS.md. */}
        {!user.isGuest && <Link to="/lobby">&larr; Lobby</Link>}
        <div className="table-header-name">
          {state.tableName}
          {sock.isPractice ? <span className="seat-tag">practice</span> : state.settings.isPrivate && <span className="seat-tag">private</span>}
        </div>
        <div className="table-header-right">
          {!mySeat && myWaitlistIndex === 0 && hasEmptySeat && <span className="seat-tag seat-tag-allin">A seat is open!</span>}
          {mySeat && (
            <button
              type="button"
              onClick={() => {
                // Any real account (admin, or a signed-in non-guest human)
                // always has a lobby to go back to, so their own "Leave
                // table" stays the simple, immediate action it always was.
                // An invited guest gets a confirm first — see the modal
                // below and DECISIONS.md.
                if (!user.isGuest) {
                  void sock.leaveTable().then(() => navigate('/lobby'));
                } else {
                  setLeaveConfirmOpen(true);
                }
              }}
            >
              Leave table
            </button>
          )}
          {canManageLayout && (
            <button type="button" className="owner-menu-toggle" aria-label="Table menu" title="Table controls" onClick={() => setOwnerMenuOpen(true)}>
              <span aria-hidden="true">☰</span> Menu
            </button>
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

      {pendingNotice && <div className="pending-settings-banner">Next hand: {pendingNotice}</div>}
      {/* Nobody to talk to at a practice table — only its own player and computer players ever sit there. */}
      {!sock.isPractice && (
        <VoicePanel voice={voice} myName={user.displayName} amSeated={!!mySeat} unseatedPeers={unseatedVoicePeers} canSeeVideo={canSeeVideo} />
      )}
      {speakerBarActive && <SpeakerBar tiles={speakerTiles} />}

      {!sock.isPractice && (
        <WaitlistPanel
          waitlist={state.waitlist}
          myUserId={user.id}
          canJoin={!mySeat}
          onJoin={() => sock.joinWaitlist()}
          onLeave={() => sock.leaveWaitlist()}
        />
      )}

      <div ref={feltRef} className={`felt${videoBoostActive ? ' felt-video-boost' : ''}`} style={seatSizeVars(positions.length)}>
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
          className={`immersive-toggle${!immersive.active && !fullScreenDiscovered ? ' immersive-toggle--attention' : ''}`}
          onClick={() => {
            if (!fullScreenDiscovered) {
              setFullScreenDiscovered(true);
              try {
                window.localStorage.setItem('pokerclause.fullScreenUsed', '1');
              } catch {
                // Storage unavailable — it simply pulses again next visit.
              }
            }
            immersive.toggle();
          }}
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
                  justRevealed={justRevealedSeats.has(seatId)}
                  voice={voiceStreamForSeat(seat)}
                  showVideo={canSeeVideo && (immersiveCameraFitActive ? !immersiveHiddenCameraSeatIds.has(String(seatId)) : !speakerBarActive)}
                  // Self-serve seating/bots are admin-only on any table, OR
                  // open to a signed-in (non-guest) human on the ONE table
                  // they created (sock.canManageTable — see
                  // socketServer.ts's canManageTable and its own doc
                  // comment). Inviting another real human (onAssignHumanClick)
                  // and rebuying (onRebuyClick) stay admin-only everywhere,
                  // full stop — see DECISIONS.md. Nobody but its own
                  // player ever sits at a practice table.
                  onEmptySeatClick={
                    (user.role === 'admin' || sock.canManageTable) && !sock.isPractice && !mySeat && seat.status === 'empty' ? () => openSeatModal(seatId) : undefined
                  }
                  onAddBotClick={
                    (user.role === 'admin' || sock.canManageTable) && seat.status === 'empty' ? () => openAddBotModal(seatId) : undefined
                  }
                  onAssignHumanClick={user.role === 'admin' && !sock.isPractice && seat.status === 'empty' ? () => openAssignModal(seatId) : undefined}
                  // Owner-only, like every table control (the server rejects anyone else).
                  onRemoveBotClick={seat.isBot && canManage ? () => sock.removeBot(seatId) : undefined}
                  // Hidden in full screen / immersive mode — it renders as a
                  // corner overlay on the seat's video tile, which in
                  // immersive mode is the player's whole visible camera and
                  // the button ends up covering their face. Exiting full
                  // screen brings it back; the owner can still rebuy anyone
                  // that way. See DECISIONS.md.
                  onRebuyClick={
                    user.role === 'admin' && !seat.isBot && seat.status !== 'empty' && !immersive.active
                      ? () => openRebuyModal(seatId, seat.stack, seat.pendingChips)
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
          smallBlind={state.settings.smallBlind}
          onAction={(type, amountTo) => {
            if (!state.handId) return;
            sock.submitAction(state.handId, state.actionSeq, type, amountTo);
          }}
        />
      )}
      {!state.legalActions && revealEligible && (
        <RevealHandButton
          label={revealLabel}
          onReveal={() => {
            if (state.handId) sock.revealHand(state.handId);
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

      {ownerMenuOpen && canManageLayout && tableId && (
        <OwnerMenu
          state={state}
          sock={sock}
          isAdmin={user.role === 'admin'}
          accessToken={accessToken}
          tableId={tableId}
          onClose={() => setOwnerMenuOpen(false)}
          onAddBot={(seatId) => {
            setOwnerMenuOpen(false);
            openAddBotModal(seatId);
          }}
          onInvite={(seatId) => {
            setOwnerMenuOpen(false);
            openAssignModal(seatId);
          }}
          onSitHere={
            mySeat
              ? null
              : (seatId) => {
                  setOwnerMenuOpen(false);
                  openSeatModal(seatId);
                }
          }
          onReset={() => {
            setOwnerMenuOpen(false);
            setResetConfirmOpen(true);
          }}
          onTerminate={() => {
            setOwnerMenuOpen(false);
            setTerminateConfirmOpen(true);
          }}
        />
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
              <MoneyInput minCents={state.settings.minBuyIn} maxCents={state.settings.maxBuyIn} cents={buyIn} onChange={setBuyIn} />
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
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Buy-in ({formatChips(state.settings.minBuyIn)} &ndash; {formatChips(state.settings.maxBuyIn)})
              <MoneyInput minCents={state.settings.minBuyIn} maxCents={state.settings.maxBuyIn} cents={botBuyIn} onChange={setBotBuyIn} />
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
            {state.phase === 'in-hand' && <p>A hand is in progress: if they&rsquo;re still in it, the chips land the moment it ends.</p>}
            <label>
              Amount ($)
              <MoneyInput minCents={1} cents={rebuyAmount} onChange={setRebuyAmount} />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setRebuyModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={rebuyAmount === '' || rebuyAmount <= 0}
                onClick={() => {
                  if (rebuyAmount === '' || rebuyAmount <= 0) return;
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
                  <MoneyInput minCents={state.settings.minBuyIn} maxCents={state.settings.maxBuyIn} cents={assignBuyIn} onChange={setAssignBuyIn} />
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

      {/* Guest-only (see the "Leave table" button above — the owner's own
          click never opens this): an invited guest has no lobby/login/
          account page to land on, so leaving fully ends their (ephemeral,
          password-less) session instead. See Left.tsx, DECISIONS.md. */}
      {leaveConfirmOpen && (
        <div className="modal-backdrop" onClick={() => setLeaveConfirmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Leave this table?</h3>
            <p>
              You won&rsquo;t be able to get back in unless the table owner sends you a new invite link &mdash; this ends your
              session entirely. If you just want a break, close this and use &ldquo;Sit out next hand&rdquo; instead.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setLeaveConfirmOpen(false)}>
                No, stay
              </button>
              <button
                type="button"
                className="btn-owner-danger"
                onClick={() => {
                  setLeaveConfirmOpen(false);
                  leavingIntentionallyRef.current = true;
                  // Navigate to the ungated /left route BEFORE logging
                  // out, not after — /table/:tableId's own route element
                  // is `user ? <TablePage/> : <RedirectToLogin/>`, so
                  // clearing `user` first (via logout) while still on
                  // that route swaps straight to <RedirectToLogin/> (a
                  // trip through /login this whole flow exists to avoid)
                  // before this component's own navigate ever gets a
                  // chance to run.
                  void sock.leaveTable()
                    .then(() => navigate('/left', { replace: true }))
                    .then(() => logout());
                }}
              >
                Yes, leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

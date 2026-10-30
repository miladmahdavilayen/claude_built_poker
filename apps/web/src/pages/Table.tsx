import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { SeatActionMenu, useSeatDoubleTap, useSeatMenuGesture, type SeatAction } from '../components/SeatActionMenu.js';
import { SeatOfferBanner } from '../components/SeatOfferBanner.js';
import { NO_SPLIT_EFFECTS, SplitPotAnnouncement, type SplitSeatEffects } from '../components/SplitPotAnnouncement.js';
import { TableMenu, TableMenuSection } from '../components/TableMenu.js';
import { TableViewOptions } from '../components/TableViewMenu.js';
import { DealerVoiceIcon } from '../components/DealerVoiceIcon.js';
import { MuteAllCallsButton, PeerMuteButton } from '../components/CallAudioButtons.js';
import { TableSoundButton } from '../components/TableSoundButton.js';
import { LeaveTableButton, SitOutButton } from '../components/SeatPresenceButtons.js';
import { setTableSoundMuted } from '../sound.js';
import { SeatCallControls } from '../components/SeatCallControls.js';
import { DealerPicker } from '../components/DealerPicker.js';
import { SeatMoveModal } from '../components/SeatMoveModal.js';
import { FairnessCheck } from '../components/FairnessCheck.js';
import { dealerModelUrl, tableTheme, useDealerCharacters } from '../table3d/dealers.js';
import type { PotAnimator } from '../table3d/TableScene3D.js';
import { useTableView } from '../table3d/useTableView.js';
import type { ChatMessageRecord } from '../types.js';
import { requestSeatAlerts, useSeatOfferAlert } from '../useSeatOfferAlert.js';
import { RevealHandButton } from '../components/RevealHandButton.js';
import { Seat, type SeatVoiceStream } from '../components/Seat.js';
import { UnseatedTile, VoicePanel } from '../components/VoicePanel.js';
import { unlockMedia, useMediaBlocked } from '../mediaUnlock.js';
import { speechSupported, unlockSpeechOnFirstTap, useDealerAnnouncements, useDealerVoiceChoice, type DealerVoiceChoice } from '../dealerVoice.js';
import { WaitlistPanel } from '../components/WaitlistPanel.js';
import { WinCelebration } from '../components/WinCelebration.js';
import { BOT_PERSONAS } from '../botPersonas.js';
import { formatChips } from '../chips.js';
import { isBluffHand } from '../handStrength.js';
import { blindTags, computePositionLabels } from '../positionLabels.js';
import { livePotTotal } from '../potTotal.js';
import { seatPositionsFor, seatSizeVars, type SeatPosition } from '../seatLayout.js';
import { useActiveSpeakers } from '../useActiveSpeakers.js';
import { useCameraFit } from '../useCameraFit.js';
import { useTableLayout } from '../useTableLayout.js';
import { fakeCameraStream } from '../devFakeCamera.js';
import { useImmersiveMode } from '../useImmersiveMode.js';
import { useIsCompactScreen } from '../useIsCompactScreen.js';
import { useJustRevealedSeats } from '../useJustRevealedSeats.js';
import { useNoTableSelection } from '../useNoTableSelection.js';
import { useSocket } from '../useSocket.js';
import { useTableSocket } from '../useTableSocket.js';
import { useVoiceChat } from '../useVoiceChat.js';
import { ErrorBanner } from '../components/ErrorBanner.js';

/**
 * Chooses which seats' cameras stay visible once the table has collapsed
 * (more than 4 cameras on a phone): the currently-active speakers first
 * (already most-recent-first), then backfilled in ascending seat order so
 * the view never sits empty right when the 5th camera turns on, before
 * anyone's spoken yet — the keep-priority when the camera tiles can't all
 * fit (see useCameraFit.ts).
 */
// The 3D table and Three.js load only when a table is shown in 3D.
const TableScene3D = lazy(() => import('../table3d/TableScene3D.js'));

/**
 * A notice that shows for a while, then goes — or at once, when tapped
 * (`dismiss`). A new message shows again even if it repeats the last one:
 * `stamp` changes whenever the source raises it again.
 */
function useTransient(message: string | null, stamp: unknown, ms = 8000): { shown: string | null; dismiss: () => void } {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    setShown(message);
    if (!message) return;
    const t = setTimeout(() => setShown(null), ms);
    return () => clearTimeout(t);
  }, [message, stamp, ms]);
  return { shown, dismiss: () => setShown(null) };
}

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

export function TablePage(): React.JSX.Element {
  const { tableId } = useParams<{ tableId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const inviteCode = searchParams.get('code') ?? undefined;
  const { user, accessToken, setDisplayName } = useAuth();
  const { socket, connected } = useSocket(accessToken);
  const sock = useTableSocket(socket);
  const voice = useVoiceChat(socket);
  const audioBlocked = useMediaBlocked();
  // The house dealer's spoken calls (see dealerVoice.ts) — the voice is the viewer's choice, in the menu.
  const dealerVoiceChoice = useDealerVoiceChoice();
  // The table's own sounds are on whenever a table opens, like the dealer's voice: a mute lasts the visit.
  useEffect(() => setTableSoundMuted(false), []);
  const dealerVoice = dealerVoiceChoice.choice;
  useEffect(unlockSpeechOnFirstTap, []);
  useDealerAnnouncements(sock.latestEvents, dealerVoice, sock.state);
  // Errors float over the table for a few seconds (or until closed with their ✕), then go.
  const voiceNotice = useTransient(voice.error, voice.error);
  const tableNotice = useTransient(sock.lastError && sock.lastError.code !== 'INVALID_INVITE_CODE' ? sock.lastError.message : null, sock.lastError);
  const immersive = useImmersiveMode();
  // 3D (and at what quality) or the classic 2D table — the header's View menu.
  const view = useTableView();
  const is3d = view.effective !== '2d';
  // Where the 3D scene put each seat and the pot on screen (% of the felt), for the DOM layers over it.
  const [layout3d, setLayout3d] = useState<{
    seats: SeatPosition[];
    pot: { left: number; top: number };
    boardTop: { left: number; top: number };
  } | null>(null);
  const potAnimatorRef = useRef<PotAnimator | null>(null);
  const [splitEffects, setSplitEffects] = useState<SplitSeatEffects>(NO_SPLIT_EFFECTS);
  // On the 3D table, your action buttons wait until your cards are actually in front of you —
  // never more than a few seconds, though: the clock on your turn is already running.
  // Tied to the hand it was reported for, so a new hand starts with them not yet down.
  const [ownCardsDown, setOwnCardsDown] = useState<{
    hand: string | null;
    landed: boolean;
  }>({ hand: null, landed: false });
  const handIdRef = useRef<string | null>(null);
  handIdRef.current = sock.state?.handId ?? null;
  const onOwnCards = useCallback((landed: boolean) => setOwnCardsDown({ hand: handIdRef.current, landed }), []);
  const [waitedForCards, setWaitedForCards] = useState(false);
  const myTurnHand = sock.state?.legalActions ? sock.state.handId : null;
  useEffect(() => {
    setWaitedForCards(false);
    if (!myTurnHand) return;
    const t = setTimeout(() => setWaitedForCards(true), 3000);
    return () => clearTimeout(t);
  }, [myTurnHand]);
  // The dealer's plain-text lines in the chat (a split pot) — made the same way by every viewer, never sent.
  const [dealerChat, setDealerChat] = useState<ChatMessageRecord[]>([]);
  // The house dealer: the table's chosen character, and the owner's picker (double-tap her).
  const dealerCharacters = useDealerCharacters();
  const [dealerPickerOpen, setDealerPickerOpen] = useState(false);
  const onSplitLog = useCallback(
    (lines: string[]) => {
      const at = new Date().toISOString();
      setDealerChat((prev) => [
        ...prev.slice(-30),
        ...lines.map((message, i) => ({
          id: `dealer-${String(Date.now())}-${String(i)}`,
          tableId: tableId ?? '',
          userId: null,
          displayName: 'Dealer',
          message,
          createdAt: at,
        })),
      ]);
    },
    [tableId],
  );
  const onLayout3d = useCallback(
    (seats: SeatPosition[], pot: { left: number; top: number }, boardTop: { left: number; top: number }) => setLayout3d({ seats, pot, boardTop }),
    [],
  );
  const isCompactScreen = useIsCompactScreen();
  useNoTableSelection();
  const navigate = useNavigate();
  const [seatModal, setSeatModal] = useState<number | null>(null);
  // Moving your own seat to an empty one (anyone seated): the seat it's to.
  const [moveTarget, setMoveTarget] = useState<number | null>(null);
  /** The owner moving a computer player: its seat, while they pick an empty one — and what happened. */
  const [movingBot, setMovingBot] = useState<number | null>(null);
  const [moveBotNote, setMoveBotNote] = useState<string | null>(null);
  // The fairness check: the hand it's for, captured when opened (a new hand starting doesn't swap it).
  const [fairness, setFairness] = useState<{
    handId: string | null;
    commitment: string | null;
    board: string[];
    mine: string[];
    players: number;
  } | null>(null);
  // '' is a real intermediate state (the field cleared, not yet retyped) —
  // coercing an empty string straight to 0 made the DOM input's value jump
  // to "0" mid-edit, so retyping "500" over a cleared "500" produced "0500".
  const [buyIn, setBuyIn] = useState<number | ''>(0);
  const [seatDisplayName, setSeatDisplayName] = useState('');
  const [rebuyModal, setRebuyModal] = useState<number | null>(null);
  const [rebuyAmount, setRebuyAmount] = useState<number | ''>(0);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  // The table menu (☰, top-right) and the chat sheet (💬, bottom-left) — see the render below.
  const [menuOpen, setMenuOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<'chat' | 'log'>('chat');
  const [chatOpen, setChatOpen] = useState(false);
  const [lastSeenChatId, setLastSeenChatId] = useState<string | null | undefined>(undefined);
  const [seatMenu, setSeatMenu] = useState<{
    seatId: number;
    x: number;
    y: number;
    empty?: boolean;
  } | null>(null);
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
  // A guest's own way back in: the invite link they came by (their seat
  // invite, or the table's open-invite link) keeps working for as long as
  // the table is open — remembered here, since the seat invite's token is
  // cleaned out of the address bar once used. See Left.tsx.
  const [rejoinPath] = useState<string | null>(() => {
    if (!tableId) return null;
    const key = `pokerclause-rejoin:${tableId}`;
    const fromUrl = assignToken
      ? `/table/${tableId}?assign=${encodeURIComponent(assignToken)}`
      : inviteCode
        ? `/table/${tableId}?code=${encodeURIComponent(inviteCode)}`
        : null;
    try {
      if (fromUrl) localStorage.setItem(key, fromUrl);
      return fromUrl ?? localStorage.getItem(key);
    } catch {
      return fromUrl;
    }
  });

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
    // The URL is cleaned up right away rather than waiting on a result —
    // a page refresh shouldn't redeem it again (the link itself is kept as
    // rejoinPath, above, for coming back after leaving).
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
    () => (visibleSeatKey === '' ? [] : seatPositionsFor(visibleSeatKey.split(',').map(Number), sock.state?.viewerSeatId ?? null)),
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
  // Development only (compiled out of production builds): `?fakeCameras=1`
  // puts a stand-in camera on every occupied seat, bots included — for
  // checking the layout with a full table on camera.
  const fakeCameras = import.meta.env.DEV && searchParams.get('fakeCameras') === '1';
  const humanCameraSeats: {
    seatId: number;
    displayName: string;
    stream: MediaStream;
    isLocal: boolean;
  }[] = [];
  for (const seat of canSeeVideo ? (sock.state?.seats ?? []) : []) {
    if (seat.status === 'empty' || (seat.isBot && !fakeCameras)) continue;
    let stream: MediaStream | null = null;
    let isLocal = false;
    if (fakeCameras) {
      stream = fakeCameraStream();
    } else if (voice.inCall && seat.seatId === sock.state?.viewerSeatId && voice.localStream) {
      stream = voice.localStream;
      isLocal = true;
    } else if (seat.playerId) {
      stream = voice.peers.find((p) => p.userId === seat.playerId)?.stream ?? null;
    }
    if (stream && stream.getVideoTracks().length > 0) {
      humanCameraSeats.push({
        seatId: seat.seatId,
        displayName: seat.displayName ?? 'Player',
        stream,
        isLocal,
      });
    }
  }

  // More than 4 human players on camera on a phone-sized screen (the 2D
  // table — on the 3D table every camera stays on its player's head): every
  // seat keeps its own video except any whose tile would collide with
  // something (see useCameraFit.ts). When a collision forces a choice, the
  // viewer's own camera wins (so they can always see themselves), then
  // whoever is speaking. Laptops and tablets show every camera.
  const cameraFitActive = !is3d && isCompactScreen && humanCameraSeats.length > 4;
  const activeSpeakerIds = useActiveSpeakers(
    humanCameraSeats.map((s) => ({ id: String(s.seatId), stream: s.stream })),
    cameraFitActive,
  );
  const feltRef = useRef<HTMLDivElement>(null);
  const cameraPriority = pickSpeakerSeatIds(
    humanCameraSeats,
    [...humanCameraSeats.filter((s) => s.isLocal).map((s) => String(s.seatId)), ...activeSpeakerIds],
    humanCameraSeats.length,
  );
  const hiddenCameraSeatIds = useCameraFit(feltRef, cameraFitActive, cameraPriority, sock.state?.handId ?? null);
  // Where each seat sits and how big, solved from their measured sizes so
  // nothing ever overlaps — seats, the board, bets — see useTableLayout.ts.
  // `positions` (the plain oval) is the first-frame fallback and the ring order.
  const ringSeatIds = useMemo(() => positions.map((p) => p.seatId), [positions]);
  // The 2D table's layout solver; the 3D table places its own seats (see table3d/scene.ts).
  const tableLayout2d = useTableLayout(feltRef, is3d ? [] : ringSeatIds);
  const tableLayout = is3d ? null : tableLayout2d;
  const placedPositions = useMemo(() => {
    if (is3d) return layout3d?.seats ?? positions;
    return tableLayout
      ? positions.map((p) => ({
          ...p,
          ...(tableLayout.seats.get(p.seatId) ?? {}),
        }))
      : positions;
  }, [positions, tableLayout, is3d, layout3d]);
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

  // The owner's per-seat menu: double-tap a player's seat (hold an empty one — a single tap there
  // already offers its options), or right-click either.
  const seatGesture = useSeatMenuGesture((seatId, x, y) => setSeatMenu({ seatId, x, y }), user?.role === 'admin');
  const playerSeatGesture = useSeatDoubleTap((seatId: number, x, y) => setSeatMenu({ seatId, x, y }), user?.role === 'admin');
  // Open-invite waitlist: chime, vibrate, flash the tab, notify — when a seat is held for this viewer.
  useSeatOfferAlert(sock.state?.seatOffer ?? null, user?.id ?? '', sock.state?.tableName ?? '');
  // Chat messages that arrived while the chat was closed (or on the log tab) — the chat button's badge.
  const chatSeen = chatOpen && bottomTab === 'chat';
  const latestChatId = sock.chat.at(-1)?.id ?? null;
  useEffect(() => {
    if (lastSeenChatId === undefined && sock.chatHistoryLoaded)
      setLastSeenChatId(latestChatId); // the history on arrival counts as read
    else if (chatSeen && latestChatId !== lastSeenChatId) setLastSeenChatId(latestChatId);
  }, [chatSeen, latestChatId, lastSeenChatId, sock.chatHistoryLoaded]);
  const unreadChat = lastSeenChatId === undefined ? 0 : sock.chat.length - 1 - sock.chat.findIndex((m) => m.id === lastSeenChatId);
  const chatWithDealer = useMemo(
    () => (dealerChat.length === 0 ? sock.chat : [...sock.chat, ...dealerChat].sort((a, b) => a.createdAt.localeCompare(b.createdAt))),
    [sock.chat, dealerChat],
  );

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
  const blinds = blindTags(state.seats, state.buttonSeat, state.phase === 'in-hand');
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
  // Out of the next hand (sitting out, or about to): the sit-out button then offers to sit back in.
  const sittingOut = !!mySeat && mySeat.sittingOutNextHand;
  // On an open-invite table the queue is for people who came with its link — not the owner, who seats themselves.
  const waitlistJoinable = !mySeat && (!state.settings.openSeating || (sock.canTakeSeat && user.role !== 'admin'));
  // Something in the menu wants this viewer's attention: a seat open for them at the waitlist's head.
  const seatNews = !mySeat && myWaitlistIndex === 0 && hasEmptySeat;
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

  const voiceStreamForSeat = (seat: (typeof state.seats)[number]): SeatVoiceStream | null => {
    if (fakeCameras && seat.status !== 'empty') return { stream: fakeCameraStream(), isLocal: false };
    if (voice.inCall && seat.seatId === state.viewerSeatId && voice.localStream) {
      return { stream: voice.localStream, isLocal: true };
    }
    if (seat.playerId) {
      const peer = voice.peers.find((p) => p.userId === seat.playerId);
      if (peer?.stream) return { stream: peer.stream, isLocal: false, userId: peer.userId };
    }
    return null;
  };
  // Everyone in the call this viewer can hear (sending audio) — the mute buttons' "everyone".
  const callUserIds = voice.peers.filter((p) => !!p.stream && p.stream.getAudioTracks().length > 0).map((p) => p.userId);
  /** The button muting a player for this viewer — on their box while they're talking in the call. */
  const peerMuteFor = (userId: string | null | undefined, name: string | null | undefined): React.ReactNode =>
    userId && callUserIds.includes(userId) ? <PeerMuteButton userId={userId} name={name ?? 'player'} everyone={callUserIds} /> : undefined;
  // The other players' cameras, worn in the 3D scene (see players3d.ts's FaceScreen).
  const seatVideos3d = new Map(
    canSeeVideo ? humanCameraSeats.filter((s) => !s.isLocal && s.seatId !== state.viewerSeatId).map((s) => [s.seatId, s.stream] as const) : [],
  );
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
    // A top-up back to the table's usual stack — the owner can enter any amount.
    setRebuyAmount(Math.max(state.settings.bigBlind, (state.settings.openSeatStack ?? state.settings.maxBuyIn) - currentStack - pendingChips));
    setRebuyModal(seatId);
  };

  /** Opens the chat sheet on a tab (or closes it, tapping the tab that's showing). */
  const openSheet = (tab: 'chat' | 'log'): void => {
    setBottomTab(tab);
    setChatOpen(true);
  };

  // Open-invite table: whether this viewer can pick a free seat right now —
  // one is held while the waitlist's first person has an offer out.
  const offer = state.seatOffer;
  const freeSeats = state.seats.filter((s) => s.status === 'empty' && !state.removedSeatIds.includes(s.seatId)).length;
  const openSeatForMe = sock.canTakeSeat && (!offer || offer.userId === user.id || freeSeats > 1);

  /** The owner's per-seat menu — only what makes sense for this seat. */
  const seatActions = (seat: (typeof state.seats)[number]): SeatAction[] => {
    const id = seat.seatId;
    const actions: SeatAction[] = [];
    if (seat.status === 'empty') {
      if (!mySeat && !sock.isPractice) actions.push({ label: 'Sit here', onSelect: () => openSeatModal(id) });
      actions.push({
        label: 'Add a computer player',
        onSelect: () => openAddBotModal(id),
      });
      if (!sock.isPractice)
        actions.push({
          label: 'Invite a player to this seat',
          onSelect: () => openAssignModal(id),
        });
    } else {
      actions.push({
        label: seat.isBot ? 'Add chips' : 'Rebuy (add chips)',
        onSelect: () => openRebuyModal(id, seat.stack, seat.pendingChips),
      });
      if (seat.isBot) {
        actions.push({
          label: 'Move to another seat',
          onSelect: () => {
            setMoveBotNote(null);
            setMovingBot(id);
          },
        });
        actions.push({
          label: 'Remove computer player',
          danger: true,
          onSelect: () => sock.removeBot(id),
        });
      } else if (seat.seatId !== state.viewerSeatId)
        actions.push({
          label: 'Remove player',
          danger: true,
          onSelect: () => void sock.removePlayer(id),
        });
    }
    if (state.seats.length - state.removedSeatIds.length > 2)
      actions.push({
        label: 'Delete seat',
        danger: true,
        onSelect: () => void sock.deleteSeat(id),
      });
    return actions;
  };

  // The chat, always in the felt's bottom-left corner (the table layout
  // steers seats around it — see useTableLayout.ts; the turn's buttons and
  // the reveal button are all on the right). A badge counts what's unread.
  // Above it, the dealer's voice, the table's sounds and the call.
  const chatButton = (
    <div
      className="table-corner"
      data-moved={tableLayout?.toggleSpot ? 'true' : undefined}
      style={
        tableLayout?.toggleSpot
          ? {
              left: tableLayout.toggleSpot.left,
              top: tableLayout.toggleSpot.top,
              bottom: 'auto',
            }
          : undefined
      }
    >
      <div className="table-corner-col">
        {/* While anyone in the call is talking: everyone's voices off and on, for you. */}
        {callUserIds.length > 0 && <MuteAllCallsButton />}
        {/* The table's own sounds (shuffle, cards, chips), right above the dealer's voice. */}
        <TableSoundButton />
        {speechSupported() && (
          <button
            type="button"
            className={`table-voice-button${dealerVoice === 'off' ? ' table-voice-button--off' : ''}`}
            aria-label={dealerVoice === 'off' ? 'Unmute the dealer' : 'Mute the dealer'}
            aria-pressed={dealerVoice === 'off'}
            title={dealerVoice === 'off' ? 'Dealer voice off — tap to turn on' : 'Dealer voice on — tap to mute'}
            onClick={dealerVoiceChoice.toggleMute}
          >
            <DealerVoiceIcon muted={dealerVoice === 'off'} />
          </button>
        )}
        <button
          type="button"
          className="table-chat-button"
          onClick={() => openSheet('chat')}
          aria-label={unreadChat > 0 ? `Chat, ${String(unreadChat)} new` : 'Chat'}
          title="Chat and hand log"
        >
          <span aria-hidden="true">💬</span>
          {unreadChat > 0 && <span className="table-chat-badge">{unreadChat > 99 ? '99+' : unreadChat}</span>}
        </button>
      </div>
      {/* Beside them, a short column of its own (the stack stays no taller): leaving, and sitting out or back in. */}
      <div className="table-corner-col">
        <LeaveTableButton onLeave={() => setLeaveConfirmOpen(true)} />
        {mySeat && <SitOutButton out={sittingOut} onToggle={() => (sittingOut ? sock.sitIn() : sock.sitOut())} />}
      </div>
    </div>
  );

  // Who may click an empty seat to sit — the owner, a table's own creator, or anyone with an open-invite link.
  const emptySeatClickable = (seat: (typeof state.seats)[number]): boolean =>
    (user.role === 'admin' || sock.canManageTable || openSeatForMe) && !sock.isPractice && !mySeat && seat.status === 'empty';

  const openFairness = (): void =>
    setFairness({
      handId: state.handId,
      commitment: state.handCommitment,
      board: [...state.board],
      mine: [...(mySeat?.holeCards ?? [])],
      players: state.seats.filter((s) => s.status === 'active' || s.status === 'folded' || s.status === 'all-in').length,
    });

  /** An empty seat's options for this viewer: sitting down, a computer player, an invite — each only where it's allowed. */
  const emptySeatOptions = (seat: (typeof state.seats)[number]): SeatAction[] => {
    const id = seat.seatId;
    // Moving a computer player: any empty seat is where it goes — one tap.
    if (movingBot !== null && seat.status === 'empty') return [{ label: 'Move here', onSelect: () => moveBotTo(id) }];
    const out: SeatAction[] = [];
    // Seated already: move here (when, and any blind it costs, are shown first).
    if (mySeat && seat.status === 'empty')
      out.push({
        label: 'Move to this seat',
        onSelect: () => setMoveTarget(id),
      });
    if (emptySeatClickable(seat)) out.push({ label: 'Sit here', onSelect: () => openSeatModal(id) });
    if (user.role === 'admin' || sock.canManageTable)
      out.push({
        label: 'Add a computer player',
        onSelect: () => openAddBotModal(id),
      });
    if (user.role === 'admin' && !sock.isPractice)
      out.push({
        label: 'Invite a player to this seat',
        onSelect: () => openAssignModal(id),
      });
    return out;
  };

  const moveBotTo = (toSeatId: number): void => {
    const from = movingBot;
    if (from === null) return;
    const name = state.seats.find((s) => s.seatId === from)?.displayName ?? 'The computer player';
    setMovingBot(null);
    void sock.moveBot(from, toSeatId).then((r) => {
      if (!r.ok) setMoveBotNote(r.message);
      else if (r.when === 'after-hand') setMoveBotNote(`${name} moves to seat ${String(toSeatId + 1)} when this hand ends.`);
      else setMoveBotNote(null);
    });
  };

  /** A seat's box — placed by % on the 2D table, or anchored in 3D by the scene (`ref`). */
  const seatSlot = (
    seatId: number,
    place: {
      style?: React.CSSProperties;
      ref?: (el: HTMLElement | null) => void;
    },
  ): React.ReactNode => {
    const seat = state.seats.find((s) => s.seatId === seatId);
    if (!seat) return null;
    const pending = splitEffects.pending.get(seatId);
    // What this viewer can do with an empty seat — offered as large options on a tap.
    const emptyOptions = seat.status === 'empty' ? emptySeatOptions(seat) : [];
    return (
      <div
        key={seatId}
        ref={place.ref}
        className={`seat-slot${user.role === 'admin' ? ' seat-slot-owner' : ''}${place.ref ? ' seat-slot--3d' : ''}`}
        data-testid={`seat-${String(seatId)}`}
        data-seat-status={seat.status}
        style={place.style}
        {...(seat.status === 'empty' ? seatGesture(seatId) : playerSeatGesture(seatId))}
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
          // On the 3D table the others' cameras are screens in the scene itself (seatVideos below); the box keeps only your own.
          showVideo={canSeeVideo && (is3d ? seatId === state.viewerSeatId : !hiddenCameraSeatIds.has(String(seatId)))}
          callControls={seatId === state.viewerSeatId && !sock.isPractice ? <SeatCallControls voice={voice} /> : undefined}
          peerMute={seatId !== state.viewerSeatId ? peerMuteFor(seat.playerId, seat.displayName) : undefined}
          // Self-serve seating/bots are admin-only on any table, OR
          // open to a signed-in (non-guest) human on the ONE table
          // they created (sock.canManageTable — see
          // socketServer.ts's canManageTable and its own doc
          // comment). Inviting another real human (onAssignHumanClick)
          // and rebuying (the seat's hold/right-click menu) stay admin-only everywhere,
          // full stop — see DECISIONS.md. Nobody but its own
          // player ever sits at a practice table.
          onEmptySeatClick={emptySeatClickable(seat) ? () => openSeatModal(seatId) : undefined}
          onAddBotClick={(user.role === 'admin' || sock.canManageTable) && seat.status === 'empty' ? () => openAddBotModal(seatId) : undefined}
          onAssignHumanClick={user.role === 'admin' && !sock.isPractice && seat.status === 'empty' ? () => openAssignModal(seatId) : undefined}
          // Owner-only, like every table control (the server rejects anyone else).
          onRemoveBotClick={seat.isBot && canManage ? () => sock.removeBot(seatId) : undefined}
          splitEffect={splitEffects.winners.has(seatId) ? 'winner' : splitEffects.dimmed.has(seatId) ? 'dim' : null}
          winningCards={splitEffects.cards}
          stackDisplay={pending !== undefined ? seat.stack - pending : undefined}
          emptyTap={
            emptyOptions.length === 0
              ? undefined
              : {
                  label: emptyOptions.length === 1 ? emptyOptions[0]!.label : 'Tap to fill',
                  onTap: (x, y) => (emptyOptions.length === 1 ? emptyOptions[0]!.onSelect() : setSeatMenu({ seatId, x, y, empty: true })),
                }
          }
          // On the 3D table your own cards lie face up on the felt in front of you — not twice.
          hideOwnCards={is3d}
          ownMark={is3d && seatId === state.viewerSeatId && state.phase === 'in-hand' ? (state.buttonSeat === seatId ? 'D' : blinds.get(seatId)) : undefined}
          compact={is3d}
        />
      </div>
    );
  };

  return (
    // The table always fills the screen: the felt and the hand being played. Everything else is in the
    // ☰ menu (top-right), the chat (💬, bottom-left), or your own seat box (the call's buttons).
    <div className="table-page immersive">
      <button
        type="button"
        className={`table-menu-button${seatNews ? ' table-menu-button--news' : ''}`}
        aria-label="Menu"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(true)}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {menuOpen && (
        <TableMenu
          title={state.tableName}
          tags={sock.isPractice ? <span className="seat-tag">practice</span> : state.settings.isPrivate && <span className="seat-tag">private</span>}
          onClose={() => setMenuOpen(false)}
        >
          {(mySeat || user.isGuest) && (
            <TableMenuSection title="You">
              {mySeat && (
                <button type="button" onClick={() => (sittingOut ? sock.sitIn() : sock.sitOut())}>
                  {sittingOut ? 'Sit in' : 'Sit out next hand'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  // Any real account (admin, or a signed-in non-guest human)
                  // always has a lobby to go back to, so their own "Leave
                  // table" stays the simple, immediate action it always was.
                  // An invited guest — seated, waiting or watching — gets a
                  // confirm first: see the modal below.
                  setMenuOpen(false);
                  if (!user.isGuest) {
                    void sock.leaveTable().then(() => navigate('/lobby'));
                  } else {
                    setLeaveConfirmOpen(true);
                  }
                }}
              >
                Leave table
              </button>
            </TableMenuSection>
          )}
          {!sock.isPractice && (state.waitlist.length > 0 || waitlistJoinable) && (
            <TableMenuSection title="Waitlist">
              {!mySeat && myWaitlistIndex === 0 && hasEmptySeat && <p className="seat-tag seat-tag-allin">A seat is open!</p>}
              <WaitlistPanel
                waitlist={state.waitlist}
                myUserId={user.id}
                canJoin={waitlistJoinable}
                onJoin={() => {
                  requestSeatAlerts();
                  sock.joinWaitlist();
                }}
                onLeave={() => sock.leaveWaitlist()}
              />
            </TableMenuSection>
          )}
          {/* Seated, the call's buttons are on your own box; watching, they're here. */}
          {!sock.isPractice && !mySeat && (
            <TableMenuSection title="Call">
              {/* The others not seated are in the strip over the table (below) — here, only your own controls and tile. */}
              <VoicePanel voice={voice} myName={user.displayName} amSeated={false} unseatedPeers={[]} canSeeVideo={canSeeVideo} />
            </TableMenuSection>
          )}
          <TableMenuSection title="View">
            <TableViewOptions view={view} />
          </TableMenuSection>
          {speechSupported() && (
            <TableMenuSection title="Dealer voice">
              <div role="radiogroup" aria-label="Dealer voice" className="table-menu-choices">
                {(
                  [
                    ['female', 'Female'],
                    ['male', 'Male'],
                    ['off', 'Off'],
                  ] as [DealerVoiceChoice, string][]
                ).map(([value, label]) => (
                  <label key={value} className="table-view-choice">
                    <input type="radio" name="dealer-voice" checked={dealerVoice === value} onChange={() => dealerVoiceChoice.choose(value)} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <p className="table-menu-note">The house dealer calls the action out loud: checks, bets, raises, all-ins, the board, and the winning hand.</p>
            </TableMenuSection>
          )}
          <TableMenuSection title="Table">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openSheet('log');
              }}
            >
              Hand log
            </button>
            {canManageLayout && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setOwnerMenuOpen(true);
                }}
              >
                Table controls
              </button>
            )}
            {canManageLayout && !sock.isPractice && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setDealerPickerOpen(true);
                }}
              >
                Dealer and room
              </button>
            )}
            {immersive.nativeFullscreenSupported && (
              <button type="button" onClick={immersive.toggle}>
                {immersive.active ? 'Show browser bars' : 'Hide browser bars'}
              </button>
            )}
            {immersive.iphoneInBrowser && (
              <p className="table-menu-note">
                For the whole screen on iPhone: tap <strong>Share</strong> <span aria-hidden="true">⬆︎</span>, then <strong>Add to Home Screen</strong>, and open
                PokerClause from there.
              </p>
            )}
            {/* Any real account has a lobby to go back to — an invited guest's way back is the invite link they came by. */}
            {!user.isGuest && (
              <Link to="/lobby" className="table-menu-link">
                &larr; Back to lobby
              </Link>
            )}
          </TableMenuSection>
        </TableMenu>
      )}

      {/* Anyone in the call without a seat (a spectator talking) — small tiles in the top-left corner, heard by everyone. */}
      {!sock.isPractice && unseatedVoicePeers.length > 0 && (
        <div className="voice-tiles table-unseated">
          {unseatedVoicePeers.map((p) => (
            <UnseatedTile
              key={p.socketId}
              stream={p.stream}
              isLocal={false}
              label={p.displayName}
              canSeeVideo={canSeeVideo}
              peerId={p.userId}
              mute={peerMuteFor(p.userId, p.displayName)}
            />
          ))}
        </div>
      )}

      {/* Notices, floating at the top of the table rather than taking rows of the screen. */}
      <div className="table-notices">
        {audioBlocked && (
          <button type="button" className="voice-unlock" onClick={unlockMedia}>
            🔊 Tap to hear the table
          </button>
        )}
        {pendingNotice && <div className="pending-settings-banner">Next hand: {pendingNotice}</div>}
        {state.seatOffer && <SeatOfferBanner offer={state.seatOffer} myUserId={user.id} amSeated={!!mySeat} />}
        {state.settings.openSeating && !mySeat && sock.canTakeSeat && user.role !== 'admin' && freeSeats > 0 && !state.seatOffer && (
          <div className="seat-offer-banner">Pick any empty seat to sit down.</div>
        )}
        {voiceNotice.shown && <ErrorBanner message={voiceNotice.shown} onClose={voiceNotice.dismiss} />}
        {tableNotice.shown && <ErrorBanner message={tableNotice.shown} onClose={tableNotice.dismiss} />}
      </div>

      <div
        ref={feltRef}
        className={`felt${videoBoostActive ? ' felt-video-boost' : ''}${is3d ? ' felt-3d' : ''}`}
        style={
          {
            ...seatSizeVars(positions.length),
            '--fit-scale': String(tableLayout?.scale ?? 1),
            '--board-scale': String(tableLayout?.boardScale ?? 1),
            ...(tableLayout?.minFeltHeight ? { minHeight: tableLayout.minFeltHeight } : {}),
          } as React.CSSProperties
        }
      >
        {!is3d && (
          <BoardAndPot board={state.board} pots={state.pots} liveTotal={livePotTotal(state)} top={tableLayout?.boardTop} winningCards={splitEffects.cards} />
        )}
        {is3d && (
          <Suspense fallback={<div className="table3d-loading">Setting up the table…</div>}>
            <TableScene3D
              tier={view.effective === '2d' ? 'low' : view.effective.tier}
              mode={view.effective === '2d' ? 'seated' : view.effective.mode}
              reduceMotion={view.reduceMotion}
              state={state}
              events={sock.latestEvents}
              handEverDealt={handEverDealt}
              renderSeat={(seatId, ref) => seatSlot(seatId, { ref })}
              onChairClick={(seatId) => {
                // An empty chair tapped in 3D: the same options as its seat box.
                const seat = state.seats.find((s) => s.seatId === seatId);
                const options = seat ? emptySeatOptions(seat) : [];
                if (options.length === 1) options[0]!.onSelect();
                else if (options.length > 1)
                  setSeatMenu({
                    seatId,
                    x: window.innerWidth / 2 - 135,
                    y: window.innerHeight / 2 - 120,
                    empty: true,
                  });
              }}
              onPerf={view.reportFrameTime}
              onRequestMode={view.setChoice}
              onOwnCards={onOwnCards}
              dealerModel={dealerModelUrl(dealerCharacters, state.settings.houseDealer)}
              theme={tableTheme(dealerCharacters, state.settings)}
              onDealerDoubleTap={canManageLayout && !sock.isPractice ? () => setDealerPickerOpen(true) : undefined}
              onFail={view.reportFailure}
              onLayout={onLayout3d}
              potAnimatorRef={potAnimatorRef}
              winningCards={splitEffects.cards}
              seatVideos={seatVideos3d}
            />
          </Suspense>
        )}
        {state.handCommitment && (
          <div className="fairness-commitment" data-testid="fairness-commitment" title={state.handCommitment}>
            Fairness commitment: {state.handCommitment.slice(0, 12)}&hellip;
          </div>
        )}
        {state.phase === 'hand-complete' && state.handId && (
          <button type="button" className="fairness-link" onClick={openFairness}>
            Verify hand fairness
          </button>
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
        {chatButton}
        {/* The 3D table deals its own cards and moves its own chips. */}
        {!is3d && <DealAnimation events={sock.latestEvents} positions={placedPositions} />}
        <WinCelebration events={sock.latestEvents} positions={placedPositions} viewerSeatId={state.viewerSeatId} />
        <SplitPotAnnouncement
          events={sock.latestEvents}
          nameOf={(seatId) => state.seats.find((s) => s.seatId === seatId)?.displayName ?? `Seat ${String(seatId + 1)}`}
          board={state.board}
          inHandSeatIds={state.seats.filter((s) => s.status === 'active' || s.status === 'all-in' || s.status === 'folded').map((s) => s.seatId)}
          positions={placedPositions}
          potPosition={is3d ? (layout3d?.pot ?? { left: 50, top: 60 }) : { left: 50, top: (tableLayout?.boardTop ?? 42) + 11 }}
          bannerAnchor={
            is3d
              ? {
                  left: layout3d?.boardTop.left ?? 50,
                  top: (layout3d?.boardTop.top ?? 40) - 1.5,
                }
              : { left: 50, top: (tableLayout?.boardTop ?? 42) - 7 }
          }
          potAnimator={is3d ? potAnimatorRef.current : null}
          reduceMotion={view.reduceMotion}
          slow={view.slowAnimations}
          onEffects={setSplitEffects}
          onLog={onSplitLog}
        />
        {state.phase !== 'in-hand' && (
          <HandBreakPanel nextHandAt={state.nextHandAt} canStartHand={state.canStartHand} amSeated={!!mySeat} onStartHand={() => sock.startHand()} />
        )}
        {!is3d &&
          placedPositions.map(({ seatId, left, top, betLeft, betTop }) => {
            const seat = state.seats.find((s) => s.seatId === seatId);
            if (!seat) return null;
            return (
              <Fragment key={seatId}>
                {seatSlot(seatId, {
                  style: { left: `${String(left)}%`, top: `${String(top)}%` },
                })}
                {blinds.has(seatId) && (
                  // In front of the seat: just past where its bet goes, toward the middle.
                  <div
                    className={`blind-tag blind-tag--${blinds.get(seatId)!.toLowerCase()}${seatId === state.viewerSeatId ? ' blind-tag--mine' : ''}`}
                    data-testid={`blind-tag-${String(seatId)}`}
                    style={{
                      left: `${String(betLeft + (betLeft - left) * 0.4)}%`,
                      top: `${String(betTop + (betTop - top) * 0.4)}%`,
                    }}
                  >
                    {blinds.get(seatId)}
                  </div>
                )}
                {seat.status !== 'empty' && seat.committedThisStreet > 0 && (
                  <div
                    className="bet-chips-slot"
                    data-testid={`bet-chips-${String(seatId)}`}
                    style={{
                      left: `${String(betLeft)}%`,
                      top: `${String(betTop)}%`,
                    }}
                  >
                    <ChipStack amount={seat.committedThisStreet} />
                  </div>
                )}
              </Fragment>
            );
          })}
      </div>

      {state.legalActions && (!is3d || (ownCardsDown.landed && ownCardsDown.hand === state.handId) || waitedForCards) && (
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

      {chatOpen && (
        <div className="table-sheet-backdrop" onClick={() => setChatOpen(false)}>
          <div className="table-sheet" role="dialog" aria-label="Chat and hand log" onClick={(e) => e.stopPropagation()}>
            <div className="bottom-tabs">
              {(['chat', 'log'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={bottomTab === tab ? 'active' : ''}
                  aria-pressed={bottomTab === tab}
                  onClick={() => setBottomTab(tab)}
                >
                  {tab === 'chat' ? 'Chat' : 'Hand log'}
                </button>
              ))}
              <button type="button" className="table-sheet-close" aria-label="Close chat" onClick={() => setChatOpen(false)}>
                ✕
              </button>
            </div>
            {bottomTab === 'chat' ? (
              <ChatPanel messages={chatWithDealer} onSend={sock.sendChat} />
            ) : (
              <ActionLog events={sock.recentEvents} seats={state.seats} />
            )}
          </div>
        </div>
      )}

      {fairness && (
        <FairnessCheck
          handId={fairness.handId}
          commitment={fairness.commitment}
          board={fairness.board}
          myCards={fairness.mine}
          players={fairness.players}
          onClose={() => setFairness(null)}
        />
      )}

      {(movingBot !== null || moveBotNote) && (
        <div className="bot-move-bar" role="status">
          <span>
            {movingBot !== null
              ? `Tap an empty seat for ${state.seats.find((s) => s.seatId === movingBot)?.displayName ?? 'the computer player'}`
              : moveBotNote}
          </span>
          <button
            type="button"
            onClick={() => {
              setMovingBot(null);
              setMoveBotNote(null);
            }}
          >
            {movingBot !== null ? 'Cancel' : 'OK'}
          </button>
        </div>
      )}
      {moveTarget !== null && (
        <SeatMoveModal
          seatNumber={moveTarget + 1}
          quote={() => sock.changeSeat(moveTarget, true)}
          onConfirm={() => sock.changeSeat(moveTarget)}
          onClose={() => setMoveTarget(null)}
        />
      )}

      {dealerPickerOpen && canManageLayout && (
        <DealerPicker
          characters={dealerCharacters}
          current={state.settings.houseDealer}
          onClose={() => setDealerPickerOpen(false)}
          // A table that never chose its room keeps the one it has: picking a dealer doesn't move it.
          onPick={(id) =>
            void sock.updateTableSettings(
              state.settings.tableTheme
                ? { houseDealer: id }
                : {
                    houseDealer: id,
                    tableTheme: tableTheme(dealerCharacters, state.settings),
                  },
            )
          }
          theme={tableTheme(dealerCharacters, state.settings)}
          onTheme={(theme) => void sock.updateTableSettings({ tableTheme: theme })}
        />
      )}

      {seatMenu &&
        (() => {
          const seat = state.seats.find((s) => s.seatId === seatMenu.seatId);
          if (!seat) return null;
          return (
            <SeatActionMenu
              x={seatMenu.x}
              y={seatMenu.y}
              title={seat.status === 'empty' ? `Seat ${String(seat.seatId + 1)} — empty` : (seat.displayName ?? `Seat ${String(seat.seatId + 1)}`)}
              actions={seatMenu.empty ? emptySeatOptions(seat) : seatActions(seat)}
              large={!!seatMenu.empty}
              onClose={() => setSeatMenu(null)}
            />
          );
        })()}

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
            {/* A guest by an open-invite link doesn't choose: the server seats them with the table's starting chips, or what they left with. */}
            {state.settings.openSeating && state.settings.openSeatStack !== undefined && user.isGuest ? (
              <p data-testid="open-seat-stack">
                You&rsquo;ll sit with <strong>{formatChips(state.settings.openSeatStack)}</strong> in starting chips &mdash; or, if you&rsquo;ve played here
                before, the chips you left with.
              </p>
            ) : (
              <>
                <label>
                  Buy-in ({formatChips(state.settings.minBuyIn)} &ndash; {formatChips(state.settings.maxBuyIn)})
                  <MoneyInput minCents={state.settings.minBuyIn} maxCents={state.settings.maxBuyIn} cents={buyIn} onChange={setBuyIn} />
                </label>
                <p>Your chips: {formatChips(user.chips)}</p>
              </>
            )}
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
                {assignError && <ErrorBanner message={assignError} onClose={() => setAssignError(null)} />}
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
                <input type="text" className="assign-link-input" readOnly value={assignedLink} onFocus={(e) => e.currentTarget.select()} />
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
            <p>This ends the table for everyone right now, refunds every seated human&rsquo;s current stack, and cannot be undone.</p>
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
              This empties every seat and refunds every seated human&rsquo;s current stack, but the table itself stays &mdash; same name, same settings, same
              link.
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
          click never opens this): an invited guest has no lobby to land
          on, so they go to Left.tsx, which offers the way back in — the
          same invite link, for as long as the table is open. Leaving never
          closes the table. */}
      {leaveConfirmOpen && (
        <div className="modal-backdrop" onClick={() => setLeaveConfirmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Leave this table?</h3>
            {user.isGuest ? (
              <p>
                {mySeat ? 'Your seat is freed and your chips are set aside for you. ' : ''}
                You can come back any time while the table is open, with the same invite link. If you just want a short break, use &ldquo;Sit out next
                hand&rdquo; instead.
              </p>
            ) : (
              <p>
                {mySeat ? 'Your seat is freed and your chips go back to your balance. ' : ''}
                You&rsquo;ll be back in the lobby
                {mySeat ? ', and can sit down here again any time the table is open' : ''}. For a short break, use &ldquo;Sit out next hand&rdquo; instead.
              </p>
            )}
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
                  // A guest's session stays: their invite link brings them straight back (Left.tsx's "Rejoin
                  // table"). Any real account — the admin included — goes back to the lobby, as ever.
                  if (user.isGuest) {
                    void sock.leaveTable().then(() =>
                      navigate('/left', {
                        replace: true,
                        state: {
                          rejoin: rejoinPath,
                          tableName: state.tableName,
                        },
                      }),
                    );
                  } else {
                    void sock.leaveTable().then(() => navigate('/lobby'));
                  }
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

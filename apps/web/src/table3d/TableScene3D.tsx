import type { ProjectedGameEvent, ProjectedTableState } from '@pokerclause/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { avatarHue } from '../avatarColor.js';
import { formatChips } from '../chips.js';
import { blindTags } from '../positionLabels.js';
import { ActionTicker, describeTableAction, type ActionKind } from '../components/ActionTicker.js';
import { PlayingCard } from '../components/PlayingCard.js';
import type { SeatPosition } from '../seatLayout.js';
import type { QualityTier, View3dMode } from './quality.js';
import { TableScene, type SceneSnapshot, type ScreenLayout } from './scene.js';

/** What the split-pot announcement drives on the 3D table (see SplitPotAnnouncement.tsx). */
export interface PotAnimator {
  distribute(awards: readonly { seatId: number; amount: number }[], opts: { pileMs: number; slideMs: number; staggerMs: number }): void;
  finish(): void;
}

export interface TableScene3DProps {
  tier: QualityTier;
  /** Seated (your own eyes, drag to look around) or standing (the whole table from your seat). */
  mode: View3dMode;
  reduceMotion: boolean;
  state: ProjectedTableState;
  events: readonly ProjectedGameEvent[];
  handEverDealt: boolean;
  /** The seat's box (the same Seat the 2D table shows): the scene anchors `ref`'s element at the seat. */
  renderSeat: (seatId: number, ref: (el: HTMLElement | null) => void) => React.ReactNode;
  onChairClick?: ((seatId: number) => void) | undefined;
  /** Frame time, ms — Auto quality steps down while it's too slow. */
  onPerf: (avgFrameMs: number) => void;
  /** The house dealer's character file (null: the built-in dealer). */
  dealerModel: string | null;
  /** The owner double-tapped the house dealer — omitted for anyone who can't change her. */
  onDealerDoubleTap?: (() => void) | undefined;
  /** Whether your own cards are down in front of you (your action buttons wait for them). */
  onOwnCards?: ((landed: boolean) => void) | undefined;
  /** A pinch/scroll or button asked for the other 3D view (standing for the whole table, seated to sit back down). */
  onRequestMode: (mode: View3dMode) => void;
  /** WebGL wouldn't start: fall back to the 2D table. */
  onFail: () => void;
  /** Seat, pot and board positions as % of the felt (the board's: its top edge), for the DOM layers over it (win badges, the split-pot banner). */
  onLayout: (positions: SeatPosition[], pot: { left: number; top: number }, boardTop: { left: number; top: number }) => void;
  potAnimatorRef: React.MutableRefObject<PotAnimator | null>;
  /** A split pot's winning cards, raised while it's announced. */
  winningCards: ReadonlySet<string>;
  /** The other players' cameras, by seat — each worn as a screen on their head in the scene. */
  seatVideos: ReadonlyMap<number, MediaStream>;
}

/**
 * The 3D table (see scene.ts): a WebGL canvas filling the felt, and over
 * it, the DOM boxes the scene keeps anchored in 3D — every seat's box
 * (video, name, stack, position labels), each bet's amount and the pot.
 * Lazy-loaded with Three.js, so nobody downloads any of it until they're at
 * a table in 3D.
 */
/** A small number that's always the same for the same string — a player's looks stay theirs. */
function stableNumber(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

export default function TableScene3D({
  tier,
  mode,
  reduceMotion,
  state,
  events,
  handEverDealt,
  renderSeat,
  onChairClick,
  onPerf,
  onRequestMode,
  onOwnCards,
  dealerModel,
  onDealerDoubleTap,
  onFail,
  onLayout,
  potAnimatorRef,
  winningCards,
  seatVideos,
}: TableScene3DProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<TableScene | null>(null);
  const [scene, setScene] = useState<TableScene | null>(null);
  // Each new scene (a quality change) gets freshly mounted boxes, so their refs attach to it.
  const sceneGen = useRef(0);
  const [potShown, setPotShown] = useState(0);
  const [lookAway, setLookAway] = useState(false);
  const [leaning, setLeaning] = useState(false);
  const [boardShown, setBoardShown] = useState(0);
  // Each player's latest action (and a counter, so the same action twice still flashes) — for the edge markers.
  const [lastActs, setLastActs] = useState<Map<number, { text: string; kind: ActionKind; n: number }>>(new Map());
  const actsSeen = useRef<readonly ProjectedGameEvent[] | null>(null);
  useEffect(() => {
    if (events === actsSeen.current) return;
    actsSeen.current = events;
    setLastActs((prev) => {
      let next: Map<number, { text: string; kind: ActionKind; n: number }> | null = null;
      for (const e of events) {
        if (e.type === 'hand-started') next = new Map();
        if (e.type !== 'action-taken') continue;
        next ??= new Map(prev);
        next.set(e.seatId, { ...describeTableAction(e), n: (prev.get(e.seatId)?.n ?? 0) + 1 });
      }
      return next ?? prev;
    });
  }, [events]);
  const lastEventsRef = useRef<readonly ProjectedGameEvent[] | null>(null);
  const dealtRef = useRef<Set<number> | null>(null);
  // The callbacks can change every render; the scene keeps the latest without being rebuilt.
  const cbRef = useRef({ onChairClick, onPerf, onLayout, onRequestMode, onOwnCards, onDealerDoubleTap });
  cbRef.current = { onChairClick, onPerf, onLayout, onRequestMode, onOwnCards, onDealerDoubleTap };

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // A fresh canvas for every scene: a disposed renderer's context is never reused.
    const canvas = document.createElement('canvas');
    canvas.className = 'table3d-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wrap.prepend(canvas);
    let s: TableScene;
    try {
      s = new TableScene(canvas, tier, {
        onChairClick: (id) => cbRef.current.onChairClick?.(id),
        onPerf: (ms) => cbRef.current.onPerf(ms),
        onLayout: (layout: ScreenLayout) => {
          const positions: SeatPosition[] = [...layout.seats].map(([seatId, p]) => {
            const left = (p.x / layout.width) * 100;
            const top = (p.y / layout.height) * 100;
            return { seatId, left, top, betLeft: left, betTop: top };
          });
          cbRef.current.onLayout(
            positions,
            { left: (layout.pot.x / layout.width) * 100, top: (layout.pot.y / layout.height) * 100 },
            { left: (layout.board.x / layout.width) * 100, top: (layout.boardTop / layout.height) * 100 },
          );
        },
        onPotShown: setPotShown,
        onLookAway: setLookAway,
        onBoardShown: setBoardShown,
        onOwnCards: (landed) => cbRef.current.onOwnCards?.(landed),
        onDealerDoubleTap: () => cbRef.current.onDealerDoubleTap?.(),
        onRequestMode: (m) => cbRef.current.onRequestMode(m),
      });
    } catch (err) {
      console.error('The 3D table could not start; showing the 2D table instead.', err);
      canvas.remove();
      onFail();
      return;
    }
    sceneRef.current = s;
    sceneGen.current++;
    setScene(s);
    potAnimatorRef.current = { distribute: (awards, opts) => s.distributePot(awards, opts), finish: () => s.finishPot() };
    const ro = new ResizeObserver(() => s.resize(wrap.clientWidth, wrap.clientHeight));
    ro.observe(wrap);
    s.resize(wrap.clientWidth, wrap.clientHeight);
    if (import.meta.env.DEV) (window as unknown as { __scene3d?: TableScene }).__scene3d = s;
    return () => {
      ro.disconnect();
      potAnimatorRef.current = null;
      sceneRef.current = null;
      s.dispose();
      canvas.remove();
      setScene(null);
    };
    // The tier is fixed for a scene's life — a new tier is a new scene.
  }, [tier]);

  useEffect(() => {
    scene?.setReduceMotion(reduceMotion);
  }, [scene, reduceMotion]);

  // Before the seats: the first camera placement is already the right kind.
  useLayoutEffect(() => {
    scene?.setMode(mode);
  }, [scene, mode]);

  useEffect(() => {
    scene?.highlightCards(winningCards);
  }, [scene, winningCards]);

  useEffect(() => {
    scene?.setDealerModel(dealerModel);
  }, [scene, dealerModel]);

  // After the seats are applied (a layout effect), so the bodies wearing them exist.
  const videoKey = [...seatVideos].map(([id, s]) => `${String(id)}:${s.id}`).join(',');
  useEffect(() => {
    scene?.setSeatVideos(seatVideos);
  }, [scene, videoKey]);

  const seatIds = useMemo(
    () => state.seats.map((s) => s.seatId).filter((id) => !state.removedSeatIds.includes(id)),
    [state.seats, state.removedSeatIds],
  );
  const seatKey = seatIds.join(',');

  useLayoutEffect(() => {
    scene?.setSeats(seatIds, state.viewerSeatId);
  }, [scene, seatKey, state.viewerSeatId]);

  useLayoutEffect(() => {
    if (!scene) return;
    const fresh = events !== lastEventsRef.current;
    lastEventsRef.current = events;
    if (fresh) {
      for (const e of events) {
        if (e.type === 'hand-started') dealtRef.current = new Set();
        if (e.type === 'cards-dealt') dealtRef.current = new Set(e.seats);
      }
    }
    const dealt = dealtRef.current;
    const snapshot: SceneSnapshot = {
      seats: state.seats
        .filter((s) => !state.removedSeatIds.includes(s.seatId))
        .map((s) => ({
          seatId: s.seatId,
          occupied: s.status !== 'empty',
          inHand: handEverDealt && state.phase !== 'waiting' && (s.status === 'active' || s.status === 'all-in') && (dealt === null || dealt.has(s.seatId)),
          faces: s.holeCards,
          bet: s.committedThisStreet,
          hue: avatarHue(s.avatarSeed ?? s.displayName ?? 'x'),
          seed: stableNumber(s.playerId ?? s.displayName ?? String(s.seatId)),
        })),
      viewerSeatId: state.viewerSeatId,
      board: state.board,
      potTotal: state.seats.reduce((sum, s) => sum + s.committedThisHand, 0) + state.anteTotal,
      buttonSeat: handEverDealt ? state.buttonSeat : null,
    };
    scene.apply(snapshot, fresh ? events : null);
  }, [scene, state, events, handEverDealt]);

  // One stable ref callback per key — a fresh one every render would detach and re-measure every box each time.
  const refCallbacks = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const overlayRef = (key: string): ((el: HTMLElement | null) => void) => {
    let fn = refCallbacks.current.get(key);
    if (!fn) {
      fn = (el) => sceneRef.current?.setOverlay(key, el);
      refCallbacks.current.set(key, fn);
    }
    return fn;
  };

  return (
    <div ref={wrapRef} className={`table3d table3d--${mode}`} data-testid="table-3d" data-tier={tier} data-mode={mode}>
      <div className="table3d-vignette" aria-hidden="true" />
      {mode === 'seated' && lookAway && (
        <button type="button" className="table3d-recenter" aria-label="Center view" onClick={() => scene?.recenterLook()}>
          <span aria-hidden="true">⊙</span>
          <span className="table3d-btn-label"> Center view</span>
        </button>
      )}
      {mode === 'seated' && state.viewerSeatId !== null && (
        <>
          <div className="table3d-look-hint" aria-hidden="true">
            Drag to look around · pull down to lean over the board · double-tap to center
          </div>
          {/* Bend forward over the rail for a closer look — at seats 1 and 9 you also lean in on your own when you turn toward the dealer. */}
          <button
            type="button"
            className={`table3d-lean${leaning ? ' table3d-lean--on' : ''}`}
            aria-pressed={leaning}
            aria-label={leaning ? 'Sit back' : 'Lean in'}
            onClick={() => {
              const on = !leaning;
              setLeaning(on);
              scene?.setLean(on);
            }}
          >
            <span aria-hidden="true">{leaning ? '⇩' : '⇧'}</span>
            <span className="table3d-btn-label">{leaning ? ' Sit back' : ' Lean in'}</span>
          </button>
          <button
            type="button"
            className="table3d-whole"
            aria-label="Whole table"
            onClick={() => onRequestMode('standing')}
            title="Stand up for a view of the whole table (or pinch out)"
          >
            <span aria-hidden="true">⤢</span>
            <span className="table3d-btn-label"> Whole table</span>
          </button>
        </>
      )}
      {mode === 'standing' && state.viewerSeatId !== null && (
        <button type="button" className="table3d-whole" aria-label="My seat" onClick={() => onRequestMode('seated')} title="Sit back down (or pinch in)">
          <span aria-hidden="true">⤡</span>
          <span className="table3d-btn-label"> My seat</span>
        </button>
      )}
      {scene && (
        <div className="table3d-overlays" key={sceneGen.current}>
          <div ref={overlayRef('board')} className="board-area board-area--3d" aria-hidden="true" />
          {/*
            The board, upright for everyone: the cards on the felt lie the way
            the house dealer turns them, which reads upside down or edge-on
            from many seats — this strip reads the same from all of them. A
            card shows here only once it's down and turned on the table.
          */}
          {boardShown > 0 && state.board.length > 0 && (
            <div className="board-hud" data-testid="board-hud" aria-label="Board">
              {state.board.slice(0, boardShown).map((c, i) => (
                <PlayingCard key={`${c}-${String(i)}`} card={c} winning={winningCards.has(c)} />
              ))}
            </div>
          )}
          <ActionTicker events={events} seats={state.seats} />
          {/* Seated: a marker at the screen's edge for each player out of view — the scene shows and places them. */}
          {mode === 'seated' &&
            state.viewerSeatId !== null &&
            state.seats
              .filter((s) => s.status !== 'empty' && s.seatId !== state.viewerSeatId && seatIds.includes(s.seatId))
              .map((s) => {
                const act = lastActs.get(s.seatId);
                return (
                  <div
                    key={`edge-${String(s.seatId)}`}
                    ref={overlayRef(`edge:${String(s.seatId)}`)}
                    className={`seat-edge-marker${s.status === 'folded' ? ' seat-edge-marker--folded' : ''}${state.betting.actingSeat === s.seatId ? ' seat-edge-marker--acting' : ''}`}
                    data-testid={`edge-${String(s.seatId)}`}
                  >
                    <span className="seat-edge-arrow" aria-hidden="true" />
                    <span className="seat-edge-name">{s.displayName ?? `Seat ${String(s.seatId + 1)}`}</span>
                    <span className="seat-edge-stack">{formatChips(s.stack)}</span>
                    {s.committedThisStreet > 0 && <span className="seat-edge-bet">bet {formatChips(s.committedThisStreet)}</span>}
                    {act && (
                      <span key={act.n} className={`seat-edge-act action-ticker-line--${act.kind}`}>
                        {act.text}
                      </span>
                    )}
                  </div>
                );
              })}
          {/* The board for screen readers (and tests): it's drawn in 3D. */}
          <div className="sr-only" data-testid="board-3d">
            Board: {state.board.length > 0 ? state.board.join(' ') : 'none yet'}
          </div>
          {seatIds.map((id) => renderSeat(id, overlayRef(`seat:${String(id)}`)))}
          {[...blindTags(state.seats, state.buttonSeat, state.phase === 'in-hand')]
            // Yours shows on your own box instead (Seat's ownMark).
            .filter(([id]) => seatIds.includes(id) && id !== state.viewerSeatId)
            .map(([id, tag]) => (
              <div
                key={`blind-${String(id)}`}
                ref={overlayRef(`blind:${String(id)}`)}
                className={`blind-tag blind-tag--3d blind-tag--${tag.toLowerCase()}`}
                data-testid={`blind-tag-${String(id)}`}
              >
                {tag}
              </div>
            ))}
          {state.seats
            .filter((s) => s.status !== 'empty' && s.committedThisStreet > 0 && seatIds.includes(s.seatId))
            .map((s) => (
              <div
                key={`bet-${String(s.seatId)}`}
                ref={overlayRef(`bet:${String(s.seatId)}`)}
                className="bet-chips-slot bet-chips-slot--3d"
                data-testid={`bet-chips-${String(s.seatId)}`}
              >
                <span className="chip-stack-amount">{formatChips(s.committedThisStreet)}</span>
              </div>
            ))}
          <div ref={overlayRef('pot')} className={`pot-display pot-display--3d${potShown > 0 ? '' : ' pot-display--empty'}`}>
            {potShown > 0 && (
              <>
                <span>Pot: {formatChips(potShown)}</span>
                {state.pots.length > 1 && <span className="side-pots"> ({state.pots.map((p) => formatChips(p.amount)).join(' + ')})</span>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

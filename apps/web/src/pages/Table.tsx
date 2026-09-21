import { Fragment, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { API_BASE } from '../api.js';
import { useAuth } from '../AuthContext.js';
import { ActionBar } from '../components/ActionBar.js';
import { ActionLog } from '../components/ActionLog.js';
import { ActionTimer } from '../components/ActionTimer.js';
import { BoardAndPot } from '../components/BoardAndPot.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { ChipStack } from '../components/ChipStack.js';
import { Seat } from '../components/Seat.js';
import { VoicePanel } from '../components/VoicePanel.js';
import { WaitlistPanel } from '../components/WaitlistPanel.js';
import { BOT_PERSONAS } from '../botPersonas.js';
import { computePositionLabels } from '../positionLabels.js';
import { livePotTotal } from '../potTotal.js';
import { seatPositions } from '../seatLayout.js';
import { useSocket } from '../useSocket.js';
import { useTableSocket } from '../useTableSocket.js';
import { useVoiceChat } from '../useVoiceChat.js';

export function TablePage(): React.JSX.Element {
  const { tableId } = useParams<{ tableId: string }>();
  const [searchParams] = useSearchParams();
  const inviteCode = searchParams.get('code') ?? undefined;
  const { user, accessToken } = useAuth();
  const { socket, connected } = useSocket(accessToken);
  const sock = useTableSocket(socket);
  const voice = useVoiceChat(socket);
  const [seatModal, setSeatModal] = useState<number | null>(null);
  const [buyIn, setBuyIn] = useState(0);
  const [rebuyOpen, setRebuyOpen] = useState(false);
  const [rebuyAmount, setRebuyAmount] = useState(0);
  const [bottomTab, setBottomTab] = useState<'chat' | 'log'>('chat');
  const [addBotModal, setAddBotModal] = useState<number | null>(null);
  const [botPersona, setBotPersona] = useState(BOT_PERSONAS[0]!.id);
  const [botBuyIn, setBotBuyIn] = useState(0);

  useEffect(() => {
    if (connected && tableId) sock.joinTable(tableId, inviteCode);
  }, [connected, tableId, inviteCode]);

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
    setSeatModal(seatId);
  };

  const confirmTakeSeat = (): void => {
    if (seatModal === null || !tableId) return;
    sock.takeSeat(tableId, seatModal, buyIn);
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

  return (
    <div className="table-page">
      <div className="table-header">
        <Link to="/lobby">&larr; Lobby</Link>
        <div className="table-header-name">
          {state.tableName}
          {state.settings.isPrivate && <span className="seat-tag">private</span>}
        </div>
        <div className="table-header-right">
          {!mySeat && myWaitlistIndex === 0 && hasEmptySeat && <span className="seat-tag seat-tag-allin">A seat is open!</span>}
          {mySeat && (
            <button type="button" onClick={() => sock.leaveTable()}>
              Leave table
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
          {mySeat && (
            <button
              type="button"
              onClick={() => {
                setRebuyAmount(state.settings.maxBuyIn - mySeat.stack);
                setRebuyOpen(true);
              }}
            >
              Rebuy
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

      <div className="felt">
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
        {state.betting.actingSeat !== null && (
          <ActionTimer deadline={state.actionDeadline} totalSeconds={state.settings.actionSeconds} />
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
                  isButton={state.buttonSeat === seatId}
                  isActing={state.betting.actingSeat === seatId}
                  isViewer={state.viewerSeatId === seatId}
                  positionLabel={positionLabels.get(seatId)}
                  voice={voiceStreamForSeat(seat)}
                  onEmptySeatClick={!mySeat && seat.status === 'empty' ? () => openSeatModal(seatId) : undefined}
                  onAddBotClick={seat.status === 'empty' ? () => openAddBotModal(seatId) : undefined}
                  onRemoveBotClick={seat.isBot ? () => sock.removeBot(seatId) : undefined}
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
              Buy-in ({state.settings.minBuyIn.toLocaleString()} &ndash; {state.settings.maxBuyIn.toLocaleString()})
              <input
                type="number"
                min={state.settings.minBuyIn}
                max={state.settings.maxBuyIn}
                value={buyIn}
                onChange={(e) => setBuyIn(Number(e.target.value))}
              />
            </label>
            <p>Your chips: {user.chips.toLocaleString()}</p>
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
              Buy-in ({state.settings.minBuyIn.toLocaleString()} &ndash; {state.settings.maxBuyIn.toLocaleString()})
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

      {rebuyOpen && mySeat && (
        <div className="modal-backdrop" onClick={() => setRebuyOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Rebuy</h3>
            <label>
              Amount
              <input
                type="number"
                min={1}
                max={state.settings.maxBuyIn - mySeat.stack}
                value={rebuyAmount}
                onChange={(e) => setRebuyAmount(Number(e.target.value))}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setRebuyOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  sock.rebuy(rebuyAmount);
                  setRebuyOpen(false);
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

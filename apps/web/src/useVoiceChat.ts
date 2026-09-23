import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSharedAudioContext } from './useActiveSpeakers.js';

/**
 * Peer-to-peer voice/video for players at the same table, signaled through
 * the existing Socket.IO connection (see `registerVoiceParticipant` and
 * `rtc-signal` in apps/server/src/socket/socketServer.ts) but carrying
 * media directly between browsers via WebRTC — audio/video never passes
 * through the server. Full mesh: every participant connects directly to
 * every other participant, which is simple and fine at poker-table scale
 * (≤9 seats) but wouldn't scale to a large room.
 *
 * Every human at the table is a receive-ready peer connection from the
 * moment they arrive — NOT only once they click "Join voice" themselves.
 * `joinCall`/`leaveCall` only ever control whether THIS browser is
 * SENDING its own mic/camera (adding/removing tracks on connections that
 * already exist); they never create or tear down the connections
 * themselves. A peer connection with nothing to send just sits idle
 * (cheap — no SDP/ICE exchange even happens until there's a real track to
 * negotiate), so anyone who never opens their own mic still automatically
 * receives whoever else does. See DECISIONS.md.
 *
 * Two humans opening their mic/camera at close to the same moment is a
 * real "glare" scenario once negotiation isn't gated behind a single
 * "newcomer always initiates" rule — handled with the standard WebRTC
 * "perfect negotiation" pattern (a deterministic polite/impolite role per
 * pair, decided by comparing socket ids, so both sides agree on who backs
 * off without any extra signaling).
 *
 * STUN-only (a public Google STUN server, just for NAT address discovery)
 * — there is no TURN relay, so two players both behind strict/symmetric
 * NATs may fail to connect directly. That's a real limitation of a
 * "lightweight" self-hosted setup; a production deployment wanting
 * guaranteed connectivity would need to run a TURN server (e.g. coturn)
 * and add it to ICE_SERVERS below.
 *
 * Also requires a secure context (HTTPS, or exactly `localhost`) for
 * `getUserMedia` — browsers block camera/mic access on a plain-HTTP LAN
 * address like `http://192.168.1.x:5173`. See README.md.
 */

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

interface RtcOfferData {
  type: 'offer';
  sdp: RTCSessionDescriptionInit;
}
interface RtcAnswerData {
  type: 'answer';
  sdp: RTCSessionDescriptionInit;
}
interface RtcIceData {
  type: 'ice-candidate';
  candidate: RTCIceCandidateInit;
}
type RtcSignalData = RtcOfferData | RtcAnswerData | RtcIceData;

interface RtcParticipant {
  socketId: string;
  userId: string;
  displayName: string;
}

export interface VoicePeer {
  socketId: string;
  userId: string;
  displayName: string;
  stream: MediaStream | null;
}

export interface VoiceChatApi {
  supported: boolean;
  inCall: boolean;
  micOn: boolean;
  cameraOn: boolean;
  localStream: MediaStream | null;
  peers: VoicePeer[];
  error: string | null;
  joinCall: (withVideo: boolean) => void;
  leaveCall: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
}

/** Per-pair state for the "perfect negotiation" pattern — see this file's own doc comment. */
interface NegotiationState {
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

export function useVoiceChat(socket: Socket | null): VoiceChatApi {
  const [inCall, setInCall] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Map<string, VoicePeer>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const negotiationRef = useRef<Map<string, NegotiationState>>(new Map());

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined';

  const closePeer = useCallback((socketId: string): void => {
    pcsRef.current.get(socketId)?.close();
    pcsRef.current.delete(socketId);
    negotiationRef.current.delete(socketId);
    setPeers((prev) => {
      if (!prev.has(socketId)) return prev;
      const next = new Map(prev);
      next.delete(socketId);
      return next;
    });
  }, []);

  const closeAllPeers = useCallback((): void => {
    for (const pc of pcsRef.current.values()) pc.close();
    pcsRef.current.clear();
    negotiationRef.current.clear();
    setPeers(new Map());
  }, []);

  const createPeerConnection = useCallback(
    (info: RtcParticipant): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      // Deterministic per pair, agreed by both sides independently with no
      // extra signaling — whichever socket id sorts first is "polite"
      // (backs off on a colliding offer instead of racing it).
      const polite = !!socket && socket.id! < info.socketId;
      negotiationRef.current.set(info.socketId, { polite, makingOffer: false, ignoreOffer: false });

      const stream = localStreamRef.current;
      if (stream) for (const track of stream.getTracks()) pc.addTrack(track, stream);

      pc.ontrack = (e): void => {
        const [remoteStream] = e.streams;
        setPeers((prev) => {
          const next = new Map(prev);
          const existing = next.get(info.socketId);
          next.set(info.socketId, { ...info, stream: remoteStream ?? existing?.stream ?? null });
          return next;
        });
        // A track REMOVED via renegotiation (the other side called
        // leaveCall or toggled a track off entirely) does NOT re-fire
        // `ontrack` — the browser removes it from this same MediaStream
        // object in place instead (a `removetrack` event on the stream),
        // with no React re-render to notice unless something explicitly
        // triggers one. Without this, `hasVideo` (Seat.tsx) would keep
        // reading a stale "still has a video track" answer from a stream
        // that quietly lost it, and the video box would never hide. A
        // fresh Map (same entries, new reference) is enough to make
        // everything depending on `voice.peers` re-evaluate.
        remoteStream?.addEventListener('removetrack', () => {
          setPeers((prev) => (prev.has(info.socketId) ? new Map(prev) : prev));
        });
      };
      pc.onicecandidate = (e): void => {
        if (e.candidate) {
          socket?.emit('rtc-signal', { to: info.socketId, data: { type: 'ice-candidate', candidate: e.candidate.toJSON() } });
        }
      };
      pc.onconnectionstatechange = (): void => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(info.socketId);
      };
      // Fires whenever there's something new to negotiate — a track added
      // (at creation, if we were already sending, OR later via joinCall)
      // or removed (leaveCall). A connection with nothing ever added never
      // fires this at all, which is exactly the desired "idle until
      // someone actually sends something" behavior.
      pc.onnegotiationneeded = (): void => {
        void (async () => {
          const neg = negotiationRef.current.get(info.socketId);
          if (!neg) return;
          try {
            neg.makingOffer = true;
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket?.emit('rtc-signal', { to: info.socketId, data: { type: 'offer', sdp: offer } });
          } catch {
            // A transient negotiation failure here isn't worth surfacing
            // as a user-facing error — the next negotiationneeded (e.g.
            // from the other side's own offer) recovers it.
          } finally {
            neg.makingOffer = false;
          }
        })();
      };

      pcsRef.current.set(info.socketId, pc);
      setPeers((prev) => (prev.has(info.socketId) ? prev : new Map(prev).set(info.socketId, { ...info, stream: null })));
      return pc;
    },
    [socket, closePeer],
  );

  useEffect(() => {
    if (!socket || !supported) return;

    const onPeers = (existing: RtcParticipant[]): void => {
      for (const p of existing) createPeerConnection(p);
    };
    const onPeerJoined = (p: RtcParticipant): void => {
      createPeerConnection(p);
    };
    const onPeerLeft = ({ socketId }: { socketId: string }): void => closePeer(socketId);
    const onSignal = ({ from, data }: { from: string; data: RtcSignalData }): void => {
      void (async () => {
        let pc = pcsRef.current.get(from);
        if (!pc) {
          const known = peers.get(from);
          pc = createPeerConnection(known ?? { socketId: from, userId: from, displayName: 'Player' });
        }
        const neg = negotiationRef.current.get(from);
        if (!neg) return;

        if (data.type === 'offer') {
          // Perfect negotiation: a colliding offer (we're also mid-offer,
          // or not in a stable state) is ignored by the impolite side and
          // accepted (rolling back our own) by the polite side, so both
          // ends always converge on the same outcome without a coin flip.
          const collision = neg.makingOffer || pc.signalingState !== 'stable';
          neg.ignoreOffer = !neg.polite && collision;
          if (neg.ignoreOffer) return;
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('rtc-signal', { to: from, data: { type: 'answer', sdp: answer } });
        } else if (data.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.type === 'ice-candidate') {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch((err: unknown) => {
            if (!neg.ignoreOffer) throw err;
          });
        }
      })();
    };

    socket.on('rtc-peers', onPeers);
    socket.on('rtc-peer-joined', onPeerJoined);
    socket.on('rtc-peer-left', onPeerLeft);
    socket.on('rtc-signal', onSignal);

    return () => {
      socket.off('rtc-peers', onPeers);
      socket.off('rtc-peer-joined', onPeerJoined);
      socket.off('rtc-peer-left', onPeerLeft);
      socket.off('rtc-signal', onSignal);
    };
  }, [socket, supported, createPeerConnection, closePeer, peers]);

  // Full teardown when the socket itself goes away (navigated off the
  // table, logged out) — every peer connection, not just "if a call was
  // active," since connections now exist independently of that.
  useEffect(() => {
    if (socket) return;
    closeAllPeers();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setInCall(false);
  }, [socket, closeAllPeers]);

  const leaveCall = useCallback((): void => {
    const stream = localStreamRef.current;
    if (stream) {
      for (const pc of pcsRef.current.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track && stream.getTracks().includes(sender.track)) pc.removeTrack(sender);
        }
      }
      stream.getTracks().forEach((t) => t.stop());
    }
    localStreamRef.current = null;
    setLocalStream(null);
    setInCall(false);
    // Deliberately does NOT close any peer connection and does NOT tell
    // the server anything — every other human at the table keeps their
    // existing (now track-less again) connection to this socket, ready
    // to receive again the moment it sends something new. See this
    // file's own doc comment.
  }, []);

  const joinCall = useCallback(
    (withVideo: boolean): void => {
      if (!supported) {
        setError('Your browser does not support voice/video calling.');
        return;
      }
      setError(null);
      // Synchronous, right here, deliberately — this runs inside the real
      // click that triggered joinCall. useActiveSpeakers.ts needs this same
      // AudioContext later (once >4 cameras are on) to detect who's
      // talking, but by then there's no user gesture on the stack anymore,
      // and browsers only reliably let a suspended AudioContext actually
      // resume when `resume()` is called synchronously inside one. Calling
      // it here, opportunistically, on every call join (whether or not
      // this particular table ever hits that camera count) means it's
      // already running by the time it's needed. See getSharedAudioContext.
      getSharedAudioContext();
      void navigator.mediaDevices
        .getUserMedia({ audio: true, video: withVideo })
        .then((stream) => {
          localStreamRef.current = stream;
          setLocalStream(stream);
          setMicOn(true);
          setCameraOn(withVideo);
          setInCall(true);
          // Every peer connection already exists (created automatically
          // once this socket joined the table) — adding tracks to an
          // existing connection triggers onnegotiationneeded on its own,
          // which is what actually sends the offer. No separate
          // "announce myself" step needed.
          for (const pc of pcsRef.current.values()) {
            for (const track of stream.getTracks()) pc.addTrack(track, stream);
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Could not access microphone/camera.';
          setError(
            location.protocol !== 'https:' && location.hostname !== 'localhost'
              ? 'Camera/mic access requires HTTPS (or localhost). This page is loaded over plain HTTP.'
              : message,
          );
        });
    },
    [supported],
  );

  const toggleMic = useCallback((): void => {
    const next = !micOn;
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
  }, [micOn]);

  const toggleCamera = useCallback((): void => {
    const next = !cameraOn;
    localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
    setCameraOn(next);
  }, [cameraOn]);

  return {
    supported,
    inCall,
    micOn,
    cameraOn,
    localStream,
    peers: [...peers.values()],
    error,
    joinCall,
    leaveCall,
    toggleMic,
    toggleCamera,
  };
}

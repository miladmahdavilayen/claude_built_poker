import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Peer-to-peer voice/video for players at the same table, signaled through
 * the existing Socket.IO connection (see `rtc-*` handlers in
 * apps/server/src/socket/socketServer.ts) but carrying media directly
 * between browsers via WebRTC — audio/video never passes through the
 * server. Full mesh: every participant connects directly to every other
 * participant, which is simple and fine at poker-table scale (≤9 seats)
 * but wouldn't scale to a large room.
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

export function useVoiceChat(socket: Socket | null): VoiceChatApi {
  const [inCall, setInCall] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Map<string, VoicePeer>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined';

  const closePeer = useCallback((socketId: string): void => {
    pcsRef.current.get(socketId)?.close();
    pcsRef.current.delete(socketId);
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
    setPeers(new Map());
  }, []);

  const createPeerConnection = useCallback(
    (info: RtcParticipant, initiator: boolean): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
      };
      pc.onicecandidate = (e): void => {
        if (e.candidate) {
          socket?.emit('rtc-signal', { to: info.socketId, data: { type: 'ice-candidate', candidate: e.candidate.toJSON() } });
        }
      };
      pc.onconnectionstatechange = (): void => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(info.socketId);
      };

      pcsRef.current.set(info.socketId, pc);
      setPeers((prev) => (prev.has(info.socketId) ? prev : new Map(prev).set(info.socketId, { ...info, stream: null })));

      if (initiator) {
        void (async () => {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket?.emit('rtc-signal', { to: info.socketId, data: { type: 'offer', sdp: offer } });
        })();
      }
      return pc;
    },
    [socket, closePeer],
  );

  useEffect(() => {
    if (!socket) return;

    const onPeers = (existing: RtcParticipant[]): void => {
      for (const p of existing) createPeerConnection(p, true);
    };
    const onPeerJoined = (p: RtcParticipant): void => {
      setPeers((prev) => (prev.has(p.socketId) ? prev : new Map(prev).set(p.socketId, { ...p, stream: null })));
    };
    const onPeerLeft = ({ socketId }: { socketId: string }): void => closePeer(socketId);
    const onSignal = ({ from, data }: { from: string; data: RtcSignalData }): void => {
      void (async () => {
        let pc = pcsRef.current.get(from);
        if (data.type === 'offer') {
          if (!pc) {
            const known = peers.get(from);
            pc = createPeerConnection(known ?? { socketId: from, userId: from, displayName: 'Player' }, false);
          }
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('rtc-signal', { to: from, data: { type: 'answer', sdp: answer } });
        } else if (data.type === 'answer') {
          if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.type === 'ice-candidate' && pc) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => undefined);
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
  }, [socket, createPeerConnection, closePeer, peers]);

  const leaveCall = useCallback((): void => {
    socket?.emit('rtc-leave');
    closeAllPeers();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setInCall(false);
  }, [socket, closeAllPeers]);

  const joinCall = useCallback(
    (withVideo: boolean): void => {
      if (!supported) {
        setError('Your browser does not support voice/video calling.');
        return;
      }
      setError(null);
      void navigator.mediaDevices
        .getUserMedia({ audio: true, video: withVideo })
        .then((stream) => {
          localStreamRef.current = stream;
          setLocalStream(stream);
          setMicOn(true);
          setCameraOn(withVideo);
          setInCall(true);
          socket?.emit('rtc-join');
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
    [socket, supported],
  );

  // Leave the call automatically if the socket itself goes away (navigated off the table, logged out, etc).
  useEffect(() => {
    if (!socket && inCall) leaveCall();
  }, [socket, inCall, leaveCall]);

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

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Peer from 'simple-peer/simplepeer.min.js';
import { Socket } from 'socket.io-client';
import {
  MicrophoneIcon,
  VideoCameraIcon,
  ArrowsExpandIcon,
  MinusSmIcon,
  UsersIcon,
  XIcon,
} from '@heroicons/react/outline';
import { colorForName } from './room-yjs';

export type VideoMode = 'pill' | 'dock' | 'theater';

interface VideoCallProps {
  socket: Socket;
  me: string;
  mode: VideoMode;
  onModeChange: (mode: VideoMode) => void;
}

interface RemotePeer {
  id: string;
  name: string;
  stream: MediaStream;
}

const VideoTile = ({
  stream,
  label,
  name,
  cameraOff = false,
  className = 'w-32 h-20',
  onClick,
}: {
  stream: MediaStream;
  label: string;
  name: string;
  cameraOff?: boolean;
  className?: string;
  onClick?: () => void;
}) => {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div
      onClick={onClick}
      className={`relative rounded-xl overflow-hidden bg-ink flex-shrink-0 ring-1 ring-black/5 ${className} ${
        onClick ? 'cursor-pointer hover:ring-2 hover:ring-white/30' : ''
      }`}
    >
      {/* Video elements are always muted — audio plays via the persistent
          AudioSink elements so it survives pill/theater mode switches. */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover"
      />
      {/* Camera off -> avatar instead of a black rectangle */}
      {cameraOff && (
        <div className="absolute inset-0 grid place-items-center bg-[#232327]">
          <span
            style={{ backgroundColor: colorForName(name) }}
            className="w-1/3 max-w-[64px] min-w-[28px] aspect-square rounded-full grid place-items-center font-semibold text-white uppercase text-lg"
          >
            {name[0]}
          </span>
        </div>
      )}
      <span className="absolute bottom-1 left-1.5 max-w-[80%] truncate text-[10px] font-medium text-white bg-black/50 px-1.5 py-0.5 rounded">
        {label}
      </span>
    </div>
  );
};

// Invisible, always-mounted audio output for a remote stream.
const AudioSink = ({ stream }: { stream: MediaStream }) => {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
};

// Diagonal strike over an icon — the universal "this is off" mark.
const Struck = ({
  off,
  children,
}: {
  off: boolean;
  children: React.ReactNode;
}) => (
  <span className="relative grid place-items-center">
    {children}
    <span
      className={`absolute h-[1.5px] bg-white rounded-full rotate-45 transition-all duration-200 ${
        off ? 'w-[135%] opacity-100' : 'w-0 opacity-0'
      }`}
    />
  </span>
);

const RoundButton = ({
  onClick,
  title,
  active = true,
  small = false,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    title={title}
    className={`${
      small ? 'w-7 h-7' : 'w-9 h-9'
    } rounded-full grid place-items-center transition-colors flex-shrink-0 ${
      active ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-red-600 text-white'
    }`}
  >
    {children}
  </button>
);

const VideoCall = ({ socket, me, mode, onModeChange }: VideoCallProps) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  // Join muted with camera off — nobody should broadcast before they choose to.
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  // Peers' mic/cam state (relayed over the socket).
  const [remoteMedia, setRemoteMedia] = useState<
    Record<string, { camOn?: boolean; micOn?: boolean }>
  >({});

  const peersRef = useRef<Record<string, Peer.Instance>>({});
  const namesRef = useRef<Record<string, string>>({});
  const localStreamRef = useRef<MediaStream | null>(null);
  const offSocketRef = useRef<() => void>(() => {});
  // Socket handlers are registered once; read current toggle state via a ref.
  const mediaStateRef = useRef({ camOn: false, micOn: false });

  useEffect(() => {
    let cancelled = false;

    const createPeer = (peerId: string, initiator: boolean) => {
      const peer = new Peer({
        initiator,
        trickle: true,
        stream: localStreamRef.current || undefined,
      });

      peer.on('signal', (signal) => {
        socket.emit('rtc:signal', { to: peerId, signal });
      });
      peer.on('stream', (stream) => {
        setRemotePeers((prev) => {
          const others = prev.filter((p) => p.id !== peerId);
          return [
            ...others,
            { id: peerId, name: namesRef.current[peerId] || 'Guest', stream },
          ];
        });
      });
      const cleanup = () => {
        setRemotePeers((prev) => prev.filter((p) => p.id !== peerId));
        delete peersRef.current[peerId];
      };
      peer.on('close', cleanup);
      peer.on('error', cleanup);

      peersRef.current[peerId] = peer;
      return peer;
    };

    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Join muted with the camera truly OFF: the mic track stays acquired
        // (disabled) so unmuting is instant, but the video track is STOPPED and
        // removed so the camera hardware/indicator is released until turned on.
        stream.getAudioTracks().forEach((t) => (t.enabled = false));
        stream.getVideoTracks().forEach((t) => {
          t.stop();
          stream.removeTrack(t);
        });
        localStreamRef.current = stream;
        setLocalStream(stream);

        // Existing participants -> we initiate to them.
        const onPeers = (peers: { id: string; name: string }[]) => {
          peers.forEach((p) => {
            namesRef.current[p.id] = p.name;
            if (!peersRef.current[p.id]) createPeer(p.id, true);
          });
        };
        // A newcomer arrives -> we wait for their offer (non-initiator),
        // and tell them our current mic/cam state.
        const onPeerJoined = (p: { id: string; name: string }) => {
          namesRef.current[p.id] = p.name;
          if (!peersRef.current[p.id]) createPeer(p.id, false);
          socket.emit('room:media', mediaStateRef.current);
        };
        const onMedia = ({
          id,
          camOn,
          micOn,
        }: {
          id: string;
          camOn?: boolean;
          micOn?: boolean;
        }) => {
          setRemoteMedia((prev) => ({ ...prev, [id]: { camOn, micOn } }));
        };
        const onSignal = ({
          from,
          signal,
        }: {
          from: string;
          signal: Peer.SignalData;
        }) => {
          let peer = peersRef.current[from];
          if (!peer) peer = createPeer(from, false);
          peer.signal(signal);
        };
        const onPeerLeft = ({ id }: { id: string }) => {
          peersRef.current[id]?.destroy();
          delete peersRef.current[id];
          setRemotePeers((prev) => prev.filter((p) => p.id !== id));
        };

        socket.on('room:peers', onPeers);
        socket.on('room:peer-joined', onPeerJoined);
        socket.on('rtc:signal', onSignal);
        socket.on('room:peer-left', onPeerLeft);
        socket.on('room:media', onMedia);
        offSocketRef.current = () => {
          socket.off('room:peers', onPeers);
          socket.off('room:peer-joined', onPeerJoined);
          socket.off('rtc:signal', onSignal);
          socket.off('room:peer-left', onPeerLeft);
          socket.off('room:media', onMedia);
        };

        // Now that we're ready, ask who is already here and tell the room
        // we're joining muted with the camera off.
        socket.emit('room:get-peers');
        socket.emit('room:media', mediaStateRef.current);
      })
      .catch(() => {
        if (!cancelled) setError('Camera / microphone unavailable.');
      });

    return () => {
      cancelled = true;
      offSocketRef.current();
      Object.values(peersRef.current).forEach((p) => p.destroy());
      peersRef.current = {};
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  // Theater: Esc returns to the dock.
  useEffect(() => {
    if (mode !== 'theater') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onModeChange('dock');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onModeChange]);

  const toggleMic = () => {
    const track = localStream?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setMicOn(track.enabled);
      mediaStateRef.current = { ...mediaStateRef.current, micOn: track.enabled };
      socket.emit('room:media', mediaStateRef.current);
    }
  };
  // Turning the camera off STOPS the video track so the hardware is released
  // (indicator light off); turning it on re-acquires and re-shares with peers.
  const toggleCam = async () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    if (camOn) {
      stream.getVideoTracks().forEach((track) => {
        Object.values(peersRef.current).forEach((peer) => {
          try {
            peer.removeTrack(track, stream);
          } catch {
            /* peer may not have negotiated this track yet */
          }
        });
        track.stop();
        stream.removeTrack(track);
      });
      setLocalStream(new MediaStream(stream.getTracks()));
      setCamOn(false);
      mediaStateRef.current = { ...mediaStateRef.current, camOn: false };
      socket.emit('room:media', mediaStateRef.current);
    } else {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        const newTrack = cam.getVideoTracks()[0];
        stream.addTrack(newTrack);
        Object.values(peersRef.current).forEach((peer) => {
          peer.addTrack(newTrack, stream);
        });
        setLocalStream(new MediaStream(stream.getTracks()));
        setCamOn(true);
        mediaStateRef.current = { ...mediaStateRef.current, camOn: true };
        socket.emit('room:media', mediaStateRef.current);
      } catch {
        setCamOn(false);
      }
    }
  };

  if (error) {
    return <span className="text-xs text-white/40 px-3 py-6">{error}</span>;
  }

  // Everyone, self first. Audio sinks stay mounted in every mode so remote
  // voices keep playing even when tiles aren't visible (pill mode).
  const tiles: {
    id: string;
    name: string;
    label: string;
    stream: MediaStream;
    cameraOff: boolean;
  }[] = [
    ...(localStream
      ? [
          {
            id: 'me',
            name: me,
            label: `${me} (you)`,
            stream: localStream,
            cameraOff: !camOn,
          },
        ]
      : []),
    ...remotePeers.map((p) => ({
      id: p.id,
      name: p.name,
      label: p.name,
      stream: p.stream,
      cameraOff: remoteMedia[p.id]?.camOn === false,
    })),
  ];
  const audioSinks = remotePeers.map((p) => (
    <AudioSink key={p.id} stream={p.stream} />
  ));

  const controls = (small = false) => (
    <>
      <RoundButton
        onClick={toggleMic}
        title={micOn ? 'Mute microphone' : 'Unmute microphone'}
        active={micOn}
        small={small}
      >
        <Struck off={!micOn}>
          <MicrophoneIcon className="w-4 h-4" />
        </Struck>
      </RoundButton>
      <RoundButton
        onClick={toggleCam}
        title={camOn ? 'Turn camera off' : 'Turn camera on'}
        active={camOn}
        small={small}
      >
        <Struck off={!camOn}>
          <VideoCameraIcon className="w-4 h-4" />
        </Struck>
      </RoundButton>
    </>
  );

  let content: JSX.Element;

  if (mode === 'pill') {
    // --- Pill: tiny presence chip, rendered into the header via a portal so
    // it lives in the top bar instead of floating over the workspace. The
    // component itself stays mounted here — streams and mic/cam state
    // survive. Click the chip body to expand back to the dock. ---
    const pill = (
      <div
        onClick={() => onModeChange('dock')}
        title="Click to expand the video dock"
        className="flex items-center gap-1.5 bg-[#1c1c1c]/90 border border-white/10 rounded-full pl-3 pr-1.5 py-1 cursor-pointer shadow-lg"
      >
        <span className="flex items-center gap-1 text-xs text-white/70">
          <UsersIcon className="w-4 h-4" />
          {tiles.length}
        </span>
        {/* Inner controls shouldn't also trigger the expand click */}
        <div
          className="flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {controls(true)}
          {/* Restore the normal dock view — jumping straight to theater from
              the pill was confusing */}
          <RoundButton
            onClick={() => onModeChange('dock')}
            title="Show video dock"
            small
          >
            <ArrowsExpandIcon className="w-3.5 h-3.5" />
          </RoundButton>
        </div>
      </div>
    );
    const slot = document.getElementById('video-pill-slot');
    content = slot ? createPortal(pill, slot) : pill;
  } else if (mode === 'theater') {
    // --- Theater: full-screen overlay, spotlight + filmstrip ---
    const spotlight =
      tiles.find((t) => t.id === spotlightId) ??
      tiles.find((t) => t.id !== 'me') ??
      tiles[0];
    const rest = tiles.filter((t) => t.id !== spotlight?.id);

    content = (
      <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col p-4 sm:p-6">
        <div className="flex-1 flex gap-4 min-h-0">
          {/* Spotlight */}
          <div className="flex-1 min-w-0 grid place-items-center">
            {spotlight && (
              <VideoTile
                stream={spotlight.stream}
                label={spotlight.label}
                name={spotlight.name}
                cameraOff={spotlight.cameraOff}
                className="w-full h-full max-h-full"
              />
            )}
          </div>
          {/* Filmstrip */}
          {rest.length > 0 && (
            <div className="w-36 sm:w-44 flex flex-col gap-3 overflow-y-auto flex-shrink-0">
              {rest.map((t) => (
                <VideoTile
                  key={t.id}
                  stream={t.stream}
                  label={t.label}
                  name={t.name}
                  cameraOff={t.cameraOff}
                  className="w-full aspect-video"
                  onClick={() => setSpotlightId(t.id)}
                />
              ))}
            </div>
          )}
        </div>
        {/* Controls */}
        <div className="flex items-center justify-center gap-2 pt-4 flex-shrink-0">
          {controls()}
          <RoundButton onClick={() => onModeChange('dock')} title="Exit theater (Esc)">
            <XIcon className="w-4 h-4" />
          </RoundButton>
        </div>
      </div>
    );
  } else {
    // --- Dock: the floating panel — large tiles, slim control row below ---
    content = (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {tiles.map((t) => (
            <VideoTile
              key={t.id}
              stream={t.stream}
              label={t.label}
              name={t.name}
              cameraOff={t.cameraOff}
              className="w-44 h-28"
              onClick={() => {
                setSpotlightId(t.id);
                onModeChange('theater');
              }}
            />
          ))}
        </div>
        <div className="flex items-center justify-center gap-1.5">
          {controls(true)}
          <RoundButton
            onClick={() => onModeChange('theater')}
            title="Theater view"
            small
          >
            <ArrowsExpandIcon className="w-3.5 h-3.5" />
          </RoundButton>
          <RoundButton onClick={() => onModeChange('pill')} title="Minimize" small>
            <MinusSmIcon className="w-4 h-4" />
          </RoundButton>
        </div>
      </div>
    );
  }

  // Audio sinks render OUTSIDE the mode-specific content, in a stable slot,
  // so remote audio elements survive every mode switch uninterrupted.
  return (
    <>
      {audioSinks}
      {content}
    </>
  );
};

export default VideoCall;

import { useContext, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import {
  ClipboardCopyIcon,
  LogoutIcon,
  PencilAltIcon,
  ClockIcon,
  UsersIcon,
  SunIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  HandIcon,
  EmojiHappyIcon,
} from '@heroicons/react/outline';
import { BASE_URL } from '../../services/api';
import useAuth from '../../hooks/use-auth';
import { ToastContext } from '../../contexts/toast-context';
import Wordmark from '../../components/atoms/wordmark';
import CollabCodeEditor from './CollabCodeEditor';
import Whiteboard from './Whiteboard';
import VideoCall, { VideoMode } from './VideoCall';
import DraggableVideoDock from './DraggableVideoDock';
import PaneErrorBoundary from './PaneErrorBoundary';
import { colorForName } from './room-yjs';

type Theme = 'dark' | 'light';

interface Participant {
  id: string;
  name: string;
}

const Avatar = ({
  name,
  ring,
  size = 'md',
  hand = false,
}: {
  name: string;
  ring: string;
  size?: 'sm' | 'md';
  hand?: boolean;
}) => (
  <span className="relative inline-flex">
    <span
      title={name}
      style={{ backgroundColor: colorForName(name) }}
      className={`${
        size === 'sm' ? 'w-7 h-7 text-[11px]' : 'w-8 h-8 text-xs'
      } rounded-full grid place-items-center font-semibold text-white uppercase ring-2 ${ring}`}
    >
      {name[0]}
    </span>
    {hand && (
      <span className="absolute -top-1.5 -right-1.5 text-[11px] leading-none drop-shadow">
        ✋
      </span>
    )}
  </span>
);

const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏'];

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(
    2,
    '0'
  )}`;

const Room = () => {
  const { id: roomId } = useParams();
  const { accessToken, email } = useAuth();
  const { success } = useContext(ToastContext);
  const navigate = useNavigate();

  const [socket, setSocket] = useState<Socket | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [showPeople, setShowPeople] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [theme, setTheme] = useState<Theme>('dark');
  const [videoMode, setVideoMode] = useState<VideoMode>('dock');
  // Raised hands keyed by peer socket id (mine tracked separately since my own
  // avatar is keyed 'me', not by socket id).
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());
  const [myHandRaised, setMyHandRaised] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  // Transient floating emoji reactions.
  const [floats, setFloats] = useState<
    { key: number; emoji: string; left: number }[]
  >([]);
  const floatKey = useRef(0);
  // Server-authoritative room timer (shared by everyone in the session).
  // `offset` corrects for the difference between this client's clock and
  // the server's, so all participants render the same elapsed time.
  const [timerState, setTimerState] = useState<{
    startedAt: number;
    accumulated: number;
    running: boolean;
    offset: number;
  } | null>(null);
  const timerRunning = timerState?.running ?? true;

  // Resizable split between code editor and whiteboard (% width of code pane)
  const DEFAULT_SPLIT = 57;
  const [codeWidth, setCodeWidth] = useState(DEFAULT_SPLIT);
  const [resizing, setResizing] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const onSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const onSplitPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing || !workspaceRef.current) return;
    const rect = workspaceRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setCodeWidth(Math.min(78, Math.max(22, pct)));
  };
  const onSplitPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setResizing(false);
  };

  const me = email ?? 'Guest';
  const dark = theme === 'dark';

  const t = dark
    ? {
        root: 'bg-[#141414] text-white',
        header: 'bg-[#0f0f0f] border-white/10',
        divider: 'bg-white/10',
        pill: 'bg-white/5 hover:bg-white/10 border-white/10',
        pillText: 'text-white/60',
        pillIcon: 'text-white/40',
        subtle: 'text-white/40',
        hover: 'hover:bg-white/5',
        avatarRing: 'ring-[#0f0f0f]',
        count: 'text-white/50',
        popover: 'bg-[#1c1c1c] border-white/10 text-white',
        panelBar: 'bg-[#0f0f0f] border-white/10',
        panelText: 'text-white/50',
        panelIcon: 'text-white/40',
        wbBg: 'bg-[#101011]',
        codePlaceholder: 'bg-[#131316] text-white/40',
        border: 'border-white/10',
        toggle: 'text-white/60 hover:bg-white/10',
      }
    : {
        root: 'bg-paper text-ink',
        header: 'bg-white border-paper-2',
        divider: 'bg-paper-2',
        pill: 'bg-paper hover:bg-paper-2 border-paper-2',
        pillText: 'text-ink-soft',
        pillIcon: 'text-ink-faint',
        subtle: 'text-ink-faint',
        hover: 'hover:bg-paper',
        avatarRing: 'ring-white',
        count: 'text-ink-soft',
        popover: 'bg-white border-paper-2 text-ink',
        panelBar: 'bg-paper border-paper-2',
        panelText: 'text-ink-soft',
        panelIcon: 'text-ink-faint',
        wbBg: 'bg-white',
        codePlaceholder: 'bg-white text-ink-faint',
        border: 'border-paper-2',
        toggle: 'text-ink-soft hover:bg-paper',
      };

  useEffect(() => {
    if (!timerState) return;
    const compute = () => {
      const { accumulated, running, startedAt, offset } = timerState;
      const seconds =
        accumulated + (running ? (Date.now() + offset - startedAt) / 1000 : 0);
      setElapsed(Math.max(0, Math.floor(seconds)));
    };
    compute();
    if (!timerState.running) return;
    const timer = setInterval(compute, 1000);
    return () => clearInterval(timer);
  }, [timerState]);

  // Pause/reset act on the room's shared timer via the server.
  const toggleTimer = () => socket?.emit('timer:toggle');
  const resetTimer = () => socket?.emit('timer:reset');

  const handCount = raisedHands.size + (myHandRaised ? 1 : 0);

  const spawnReaction = (emoji: string) => {
    const key = ++floatKey.current;
    const left = 8 + Math.random() * 74;
    setFloats((f) => [...f, { key, emoji, left }]);
    setTimeout(
      () => setFloats((f) => f.filter((x) => x.key !== key)),
      2300
    );
  };

  const sendReaction = (emoji: string) => {
    socket?.emit('room:reaction', { emoji });
    spawnReaction(emoji); // show my own instantly (server relays to others)
    setReactionsOpen(false);
  };

  const toggleHand = () => {
    const next = !myHandRaised;
    setMyHandRaised(next);
    socket?.emit('room:hand', { raised: next });
  };

  useEffect(() => {
    if (!roomId || !accessToken) return;

    const s = io(`${BASE_URL}room`, {
      query: { roomId, accessToken, name: me },
    });

    const onPeers = (peers: Participant[]) => setParticipants(peers);
    const onJoined = (p: Participant) =>
      setParticipants((prev) =>
        prev.some((x) => x.id === p.id) ? prev : [...prev, p]
      );
    const onLeft = ({ id }: { id: string }) => {
      setParticipants((prev) => prev.filter((x) => x.id !== id));
      setRaisedHands((prev) => {
        if (!prev.has(id)) return prev;
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    };
    const onHands = (list: { id: string }[]) =>
      setRaisedHands(new Set(list.map((x) => x.id)));
    const onHand = ({ id, raised }: { id: string; raised: boolean }) =>
      setRaisedHands((prev) => {
        const n = new Set(prev);
        if (raised) n.add(id);
        else n.delete(id);
        return n;
      });
    const onReaction = ({ emoji }: { emoji: string }) => spawnReaction(emoji);
    const onTimer = (t: {
      startedAt: number;
      accumulated: number;
      running: boolean;
      serverNow: number;
    }) =>
      setTimerState({
        startedAt: t.startedAt,
        accumulated: t.accumulated,
        running: t.running,
        offset: t.serverNow - Date.now(),
      });

    s.on('room:peers', onPeers);
    s.on('room:peer-joined', onJoined);
    s.on('room:peer-left', onLeft);
    s.on('room:timer', onTimer);
    s.on('room:hands', onHands);
    s.on('room:hand', onHand);
    s.on('room:reaction', onReaction);

    setSocket(s);

    return () => {
      s.off('room:peers', onPeers);
      s.off('room:peer-joined', onJoined);
      s.off('room:peer-left', onLeft);
      s.off('room:timer', onTimer);
      s.off('room:hands', onHands);
      s.off('room:hand', onHand);
      s.off('room:reaction', onReaction);
      s.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, accessToken]);

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    success('Room link copied — share it to invite others.');
  };

  const everyone = [{ id: 'me', name: me }, ...participants];
  const alone = participants.length === 0;

  return (
    <div
      className={`h-screen flex flex-col font-sans overflow-hidden ${t.root}`}
    >
      {/* Top bar */}
      <header
        className={`flex items-center justify-between gap-4 px-4 py-1.5 border-b flex-shrink-0 ${t.header}`}
      >
        <div className="flex items-center gap-4 min-w-0">
          <Wordmark to="/document/create" size="sm" invert={dark} />
          <span className={`h-6 w-px hidden sm:block ${t.divider}`} />
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
            <span className="font-serif text-lg font-semibold">
              Live Session
            </span>
          </div>
          <button
            onClick={copyLink}
            title="Copy invite link"
            className={`hidden md:flex items-center gap-2 border rounded-full pl-3 pr-2 py-1 transition-colors ${t.pill}`}
          >
            <span className={`font-mono text-xs ${t.pillText}`}>{roomId}</span>
            <ClipboardCopyIcon className={`w-4 h-4 ${t.pillIcon}`} />
          </button>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Minimized video pill portals into this slot */}
          <div id="video-pill-slot" className="flex items-center" />

          {/* Session timer with pause / reset */}
          <div
            className={`hidden sm:flex items-center gap-0.5 text-xs font-mono ${t.subtle}`}
          >
            <ClockIcon className="w-4 h-4 mr-1" />
            <span className={timerRunning ? '' : 'opacity-60'}>
              {fmt(elapsed)}
            </span>
            <button
              onClick={toggleTimer}
              title={timerRunning ? 'Pause timer' : 'Resume timer'}
              className={`w-6 h-6 rounded-full grid place-items-center transition-colors ${t.hover}`}
            >
              {timerRunning ? (
                <PauseIcon className="w-3.5 h-3.5" />
              ) : (
                <PlayIcon className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              onClick={resetTimer}
              title="Reset timer"
              className={`w-6 h-6 rounded-full grid place-items-center transition-colors ${t.hover}`}
            >
              <RefreshIcon className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Theme toggle */}
          <button
            onClick={() => setTheme(dark ? 'light' : 'dark')}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className={`w-8 h-8 rounded-full grid place-items-center transition-colors ${t.toggle}`}
          >
            {dark ? (
              <SunIcon className="w-4 h-4" />
            ) : (
              <MoonIcon className="w-4 h-4" />
            )}
          </button>

          {/* Reactions */}
          <div className="relative">
            <button
              onClick={() => setReactionsOpen((v) => !v)}
              title="Send a reaction"
              className={`w-8 h-8 rounded-full grid place-items-center transition-colors ${t.toggle}`}
            >
              <EmojiHappyIcon className="w-4 h-4" />
            </button>
            {reactionsOpen && (
              <div
                className={`absolute right-0 top-full mt-2 flex items-center gap-1 border rounded-full px-2 py-1.5 shadow-2xl z-40 ${t.popover}`}
                onMouseLeave={() => setReactionsOpen(false)}
              >
                {REACTIONS.map((e) => (
                  <button
                    key={e}
                    onClick={() => sendReaction(e)}
                    className="w-8 h-8 rounded-full grid place-items-center text-lg hover:scale-125 transition-transform"
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Raise hand */}
          <button
            onClick={toggleHand}
            title={myHandRaised ? 'Lower your hand' : 'Raise your hand'}
            className={`relative w-8 h-8 rounded-full grid place-items-center transition-colors ${
              myHandRaised ? 'bg-amber-400/20 text-amber-500' : t.toggle
            }`}
          >
            <HandIcon className="w-4 h-4" />
            {handCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold grid place-items-center">
                {handCount}
              </span>
            )}
          </button>

          {/* Participants */}
          <div className="relative">
            <button
              onClick={() => setShowPeople((v) => !v)}
              className={`flex items-center gap-2 rounded-full pl-1 pr-2.5 py-1 transition-colors ${t.hover}`}
            >
              <div className="flex -space-x-2">
                {everyone.slice(0, 4).map((p) => (
                  <Avatar
                    key={p.id}
                    name={p.name}
                    ring={t.avatarRing}
                    hand={p.id === 'me' ? myHandRaised : raisedHands.has(p.id)}
                  />
                ))}
              </div>
              <span className={`text-xs ${t.count}`}>{everyone.length}</span>
            </button>

            {showPeople && (
              <div
                className={`absolute right-0 top-full mt-2 w-72 border rounded-xl shadow-2xl z-40 overflow-hidden ${t.popover}`}
                onMouseLeave={() => setShowPeople(false)}
              >
                <div className={`flex items-center gap-2 px-4 py-2.5 border-b ${t.border}`}>
                  <UsersIcon className={`w-4 h-4 ${t.panelIcon}`} />
                  <span className="text-sm font-semibold">
                    In this session ({everyone.length})
                  </span>
                </div>
                <div className="max-h-64 overflow-y-auto py-1">
                  {everyone.map((p) => (
                    <div
                      key={p.id}
                      className={`flex items-center gap-3 px-4 py-2 ${t.hover}`}
                    >
                      <Avatar
                        name={p.name}
                        ring="ring-transparent"
                        size="sm"
                        hand={
                          p.id === 'me' ? myHandRaised : raisedHands.has(p.id)
                        }
                      />
                      <p className="text-sm truncate">
                        {p.name}
                        {p.id === 'me' && (
                          <span className={`font-normal ${t.subtle}`}> (you)</span>
                        )}
                      </p>
                    </div>
                  ))}
                </div>
                <button
                  onClick={copyLink}
                  className={`w-full text-left px-4 py-2.5 border-t text-sm font-medium text-accent ${t.border} ${t.hover}`}
                >
                  + Invite people
                </button>
              </div>
            )}
          </div>

          <button
            onClick={() => navigate('/document/create')}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 px-3 py-1 rounded-full transition-colors"
          >
            <LogoutIcon className="w-4 h-4" />
            Leave
          </button>
        </div>
      </header>

      {/* Workspace */}
      <div
        ref={workspaceRef}
        className={`flex-1 flex min-h-0 relative ${
          resizing ? 'cursor-col-resize select-none' : ''
        }`}
      >
        {/* Code */}
        <div
          style={{ width: `${codeWidth}%` }}
          className={`min-w-0 h-full flex flex-col ${
            resizing ? 'pointer-events-none' : ''
          }`}
        >
          <PaneErrorBoundary label="Code editor">
            {socket ? (
              <CollabCodeEditor socket={socket} me={me} theme={theme} />
            ) : (
              <div
                className={`h-full grid place-items-center text-sm ${t.codePlaceholder}`}
              >
                Connecting to room…
              </div>
            )}
          </PaneErrorBoundary>
        </div>

        {/* Resize handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize — double-click to reset"
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={onSplitPointerUp}
          onDoubleClick={() => setCodeWidth(DEFAULT_SPLIT)}
          className={`relative z-20 w-1.5 h-full flex-shrink-0 cursor-col-resize group flex items-center justify-center border-x transition-colors ${
            t.border
          } ${
            resizing
              ? 'bg-accent/40'
              : dark
              ? 'bg-[#0f0f0f] hover:bg-white/10'
              : 'bg-paper hover:bg-paper-2'
          }`}
        >
          {/* grip dots */}
          <div
            className={`flex flex-col gap-1 pointer-events-none ${
              resizing ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'
            }`}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`w-1 h-1 rounded-full ${
                  dark ? 'bg-white/60' : 'bg-ink-faint'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Whiteboard — `isolate` contains tldraw's high z-index toolbars in
            their own stacking context so they can't overlap the theater view */}
        <div
          className={`flex-1 min-w-0 h-full flex flex-col isolate ${t.wbBg} ${
            resizing ? 'pointer-events-none' : ''
          }`}
        >
          <div
            className={`flex items-center gap-2 px-4 py-2 border-b flex-shrink-0 ${t.panelBar}`}
          >
            <PencilAltIcon className={`w-4 h-4 ${t.panelIcon}`} />
            <span
              className={`text-xs font-semibold uppercase tracking-wide ${t.panelText}`}
            >
              Whiteboard
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <PaneErrorBoundary label="Whiteboard">
              {socket ? (
                <Whiteboard socket={socket} theme={theme} />
              ) : (
                <div
                  className={`h-full grid place-items-center text-sm ${t.subtle}`}
                >
                  Connecting to room…
                </div>
              )}
            </PaneErrorBoundary>
          </div>
        </div>

        {/* Floating video call dock (kept dark in both themes) — draggable,
            snaps to a corner; minimizes to a header pill; expands to theater.
            Pill and theater render their own UI (portal / fixed overlay), so
            the dock chrome only shows in dock mode. */}
        <DraggableVideoDock asOverlay={videoMode !== 'dock'}>
          {socket && (
            <VideoCall
              socket={socket}
              me={me}
              mode={videoMode}
              onModeChange={setVideoMode}
            />
          )}
          {alone && videoMode === 'dock' && (
            <p className="text-[11px] text-white/40 text-center pt-1.5">
              Waiting for others — share the invite link.
            </p>
          )}
        </DraggableVideoDock>
      </div>

      {/* Floating emoji reactions (transient, non-interactive) */}
      <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden">
        <style>{`@keyframes verse-float{0%{transform:translateY(0) scale(.5);opacity:0}12%{opacity:1;transform:translateY(-14px) scale(1)}100%{transform:translateY(-42vh) scale(1.15);opacity:0}}`}</style>
        {floats.map((f) => (
          <span
            key={f.key}
            style={{
              left: `${f.left}%`,
              animation: 'verse-float 2.2s ease-out forwards',
            }}
            className="absolute bottom-24 text-4xl select-none"
          >
            {f.emoji}
          </span>
        ))}
      </div>
    </div>
  );
};

export default Room;

/**
 * Live Session rooms (Verse Live).
 *
 * A Socket.IO namespace ("/room") that powers real-time coding rooms:
 *   - relays Yjs updates for multiple in-room docs (e.g. "code", "whiteboard")
 *   - relays awareness (shared cursors / selections)
 *   - tracks presence (who is in the room)
 *   - passes through WebRTC signaling for peer-to-peer video/audio
 *
 * Rooms are ephemeral and in-memory (no DB persistence in this MVP): when the
 * last participant leaves, the room's state is dropped.
 */
import { Server, Socket } from 'socket.io';
import * as Y from 'yjs';
import jwt from 'jsonwebtoken';
import env from '../config/env.config';

interface RoomTimer {
  startedAt: number; // server epoch ms of the current running stretch
  accumulated: number; // seconds accumulated across previous stretches
  running: boolean;
}

interface RoomState {
  docs: Map<string, Y.Doc>;
  timer: RoomTimer;
  hands: Set<string>; // socket ids with a raised hand
}

const rooms = new Map<string, RoomState>();

const getRoom = (roomId: string): RoomState => {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      docs: new Map(),
      timer: { startedAt: Date.now(), accumulated: 0, running: true },
      hands: new Set(),
    };
    rooms.set(roomId, room);
  }
  return room;
};

// Include the server clock so clients can correct for their own clock skew.
const timerPayload = (room: RoomState) => ({
  ...room.timer,
  serverNow: Date.now(),
});

const getDoc = (roomId: string, docKey: string): Y.Doc => {
  const room = getRoom(roomId);
  let doc = room.docs.get(docKey);
  if (!doc) {
    doc = new Y.Doc();
    room.docs.set(docKey, doc);
  }
  return doc;
};

export const registerRoomNamespace = (io: Server): void => {
  const nsp = io.of('/room');

  nsp.on('connection', (socket: Socket) => {
    const query = socket.handshake.query as Record<string, string>;
    const roomId = query.roomId;
    const accessToken = query.accessToken;
    const name = query.name;

    if (!roomId || !accessToken) return socket.disconnect();

    let email = '';
    try {
      const decoded = jwt.verify(accessToken, env.ACCESS_TOKEN_SECRET) as {
        email: string;
      };
      email = decoded.email;
    } catch {
      return socket.disconnect();
    }

    const displayName = name || email || 'Guest';
    (socket as any).displayName = displayName;

    socket.join(roomId);

    const listPeers = () =>
      Array.from(nsp.adapter.rooms.get(roomId) || [])
        .filter((id) => id !== socket.id)
        .map((id) => ({
          id,
          name: (nsp.sockets.get(id) as any)?.displayName || 'Guest',
        }));

    // Tell the newcomer who is already here (so it can initiate WebRTC to them).
    socket.emit('room:peers', listPeers());

    // Bring the newcomer up to speed on any hands already raised.
    socket.emit(
      'room:hands',
      Array.from(getRoom(roomId).hands)
        .filter((id) => id !== socket.id)
        .map((id) => ({
          id,
          name: (nsp.sockets.get(id) as any)?.displayName || 'Guest',
        }))
    );

    // Clients (e.g. the video component, which mounts after acquiring camera)
    // can re-request the peer list once they are ready.
    socket.on('room:get-peers', () => socket.emit('room:peers', listPeers()));

    // Tell existing peers a newcomer arrived.
    socket.to(roomId).emit('room:peer-joined', {
      id: socket.id,
      name: displayName,
    });

    // --- Shared session timer (server-authoritative) ---
    const room = getRoom(roomId);
    socket.emit('room:timer', timerPayload(room));

    socket.on('timer:toggle', () => {
      const t = getRoom(roomId).timer;
      if (t.running) {
        t.accumulated += (Date.now() - t.startedAt) / 1000;
        t.running = false;
      } else {
        t.startedAt = Date.now();
        t.running = true;
      }
      nsp.to(roomId).emit('room:timer', timerPayload(getRoom(roomId)));
    });

    socket.on('timer:reset', () => {
      getRoom(roomId).timer = {
        startedAt: Date.now(),
        accumulated: 0,
        running: true,
      };
      nsp.to(roomId).emit('room:timer', timerPayload(getRoom(roomId)));
    });

    // --- Yjs docs (code, whiteboard, ...) ---
    socket.on('room:subscribe', (docKey: string) => {
      const doc = getDoc(roomId, docKey);
      socket.emit('room:sync', {
        docKey,
        update: Array.from(Y.encodeStateAsUpdate(doc)),
      });
    });

    socket.on(
      'room:update',
      ({ docKey, update }: { docKey: string; update: number[] }) => {
        const doc = getDoc(roomId, docKey);
        Y.applyUpdate(doc, new Uint8Array(update));
        socket.to(roomId).emit('room:update', { docKey, update });
      }
    );

    socket.on('room:awareness', (payload: { docKey: string; update: number[] }) => {
      socket.to(roomId).emit('room:awareness', payload);
    });

    // --- Media state (mic/cam on-off) so peers can show avatars, not black ---
    socket.on('room:media', (payload: { camOn?: boolean; micOn?: boolean }) => {
      socket.to(roomId).emit('room:media', { ...payload, id: socket.id });
    });

    // --- Code execution results (relay so the whole room sees run output) ---
    socket.on('code:result', (payload: unknown) => {
      socket.to(roomId).emit('code:result', payload);
    });

    // --- Teaching mode: relay the presenter's viewport so followers track it ---
    socket.on('room:follow', (payload: unknown) => {
      socket.to(roomId).emit('room:follow', payload);
    });

    // --- Raise hand (ephemeral, tracked so late joiners see current hands) ---
    socket.on('room:hand', ({ raised }: { raised: boolean }) => {
      const r = getRoom(roomId);
      if (raised) r.hands.add(socket.id);
      else r.hands.delete(socket.id);
      socket
        .to(roomId)
        .emit('room:hand', { id: socket.id, name: displayName, raised });
    });

    // --- Emoji reactions (fire-and-forget; sender renders its own locally) ---
    socket.on('room:reaction', ({ emoji }: { emoji: string }) => {
      socket
        .to(roomId)
        .emit('room:reaction', { id: socket.id, name: displayName, emoji });
    });

    // --- WebRTC signaling passthrough (peer-to-peer video/audio) ---
    socket.on('rtc:signal', ({ to, signal }: { to: string; signal: unknown }) => {
      nsp.to(to).emit('rtc:signal', { from: socket.id, signal });
    });

    socket.on('disconnect', () => {
      getRoom(roomId).hands.delete(socket.id);
      socket.to(roomId).emit('room:peer-left', { id: socket.id });
      const clients = nsp.adapter.rooms.get(roomId);
      if (!clients || clients.size === 0) rooms.delete(roomId);
    });
  });
};

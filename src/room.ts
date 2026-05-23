import { nanoid } from 'nanoid';
import type { WebSocket } from '@fastify/websocket';
import type { SessionHeaders } from './hls-proxy.js';
import type { PlayerStructure } from './extractor.js';

export interface PlaybackSnapshot {
  paused: boolean;
  currentTime: number;
  updatedAt: number;
}

export interface RoomCurrent {
  seasonId: string;
  seasonTitle: string;
  episodeId: string;
  episodeTitle: string;
  voiceTitle: string;
  voiceFile: string;
  /** Для venom-стримов (lordfilm): индекс audio track'а внутри master.m3u8. */
  audioTrack?: number;
  /**
   * Сырые URL'ы VTT субтитров эпизода (хранятся на upstream-CDN).
   * Клиент тянет через /hls/:roomId/sub/:idx — там server проксирует.
   */
  subtitles?: { url: string; name: string; lang?: string }[];
}

interface Member {
  id: string;
  name: string;
  ws: WebSocket;
}

export interface Room {
  id: string;
  sourceUrl: string;
  session: SessionHeaders;
  playlist: PlayerStructure;
  current: RoomCurrent;
  /** Увеличивается при смене source — клиенты используют для cache-busting m3u8. */
  sourceVersion: number;
  createdAt: number;
  leader: string | null;
  members: Map<string, Member>;
  snapshot: PlaybackSnapshot;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private idleTtlMs: number;

  constructor(opts: { idleTtlMs?: number } = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? 6 * 60 * 60 * 1000;
    setInterval(() => this.gc(), 5 * 60 * 1000).unref?.();
  }

  create(args: {
    sourceUrl: string;
    session: SessionHeaders;
    playlist: PlayerStructure;
    current: RoomCurrent;
  }): Room {
    const id = nanoid(21);
    const room: Room = {
      id,
      sourceUrl: args.sourceUrl,
      session: args.session,
      playlist: args.playlist,
      current: args.current,
      sourceVersion: 1,
      createdAt: Date.now(),
      leader: null,
      members: new Map(),
      snapshot: { paused: true, currentTime: 0, updatedAt: Date.now() },
    };
    this.rooms.set(id, room);
    return room;
  }

  /**
   * Сменить источник (season/episode/voice) и оповестить всех клиентов через WS.
   * Сбрасывает playback snapshot к началу — каждая смена это «новый запуск».
   */
  switchSource(roomId: string, byMemberId: string | null, current: RoomCurrent): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    // если передан memberId — только лидер может переключать
    if (byMemberId && room.leader !== byMemberId) return false;
    room.current = current;
    room.sourceVersion++;
    room.snapshot = { paused: true, currentTime: 0, updatedAt: Date.now() };
    broadcast(room, {
      type: 'source-change',
      version: room.sourceVersion,
      current: room.current,
    });
    return true;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  attach(roomId: string, ws: WebSocket, name?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      send(ws, { type: 'error', message: 'room not found' });
      ws.close();
      return;
    }

    const memberId = nanoid(10);
    const member: Member = { id: memberId, name: name?.slice(0, 32) || 'guest', ws };
    room.members.set(memberId, member);
    if (!room.leader) room.leader = memberId;

    send(ws, {
      type: 'welcome',
      selfId: memberId,
      leaderId: room.leader,
      members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name })),
      snapshot: room.snapshot,
      playlist: room.playlist,
      current: room.current,
      sourceVersion: room.sourceVersion,
    });

    broadcast(room, { type: 'member-join', id: memberId, name: member.name }, memberId);

    ws.on('message', (raw: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      handleMessage(room, memberId, msg);
    });

    const cleanup = () => {
      if (!room.members.delete(memberId)) return;
      const wasLeader = room.leader === memberId;
      if (wasLeader) {
        room.leader = room.members.keys().next().value ?? null;
        if (room.leader) {
          broadcast(room, { type: 'leader-change', leaderId: room.leader });
        }
      }
      broadcast(room, { type: 'member-leave', id: memberId });
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (room.members.size === 0 && now - room.createdAt > this.idleTtlMs) {
        this.rooms.delete(id);
      }
    }
  }
}

function handleMessage(room: Room, fromId: string, msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; [k: string]: unknown };

  switch (m.type) {
    case 'playback': {
      if (room.leader !== fromId) return;
      const paused = Boolean(m.paused);
      const currentTime = Number(m.currentTime);
      if (!Number.isFinite(currentTime)) return;
      room.snapshot = { paused, currentTime, updatedAt: Date.now() };
      broadcast(
        room,
        { type: 'playback', paused, currentTime, fromTime: room.snapshot.updatedAt },
        fromId,
      );
      return;
    }
    case 'seek': {
      if (room.leader !== fromId) return;
      const currentTime = Number(m.currentTime);
      if (!Number.isFinite(currentTime)) return;
      room.snapshot = { ...room.snapshot, currentTime, updatedAt: Date.now() };
      broadcast(
        room,
        { type: 'seek', currentTime, fromTime: room.snapshot.updatedAt },
        fromId,
      );
      return;
    }
    case 'heartbeat': {
      if (room.leader !== fromId) return;
      const currentTime = Number(m.currentTime);
      if (!Number.isFinite(currentTime)) return;
      room.snapshot = { ...room.snapshot, currentTime, updatedAt: Date.now() };
      broadcast(
        room,
        { type: 'heartbeat', currentTime, fromTime: room.snapshot.updatedAt },
        fromId,
      );
      return;
    }
    case 'claim-leader': {
      if (room.leader && room.members.has(room.leader)) return;
      room.leader = fromId;
      broadcast(room, { type: 'leader-change', leaderId: fromId });
      return;
    }
    case 'ping': {
      const member = room.members.get(fromId);
      if (member) send(member.ws, { type: 'pong', t: m.t });
      return;
    }
  }
}

function send(ws: WebSocket, obj: unknown): void {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function broadcast(room: Room, obj: unknown, exceptId?: string): void {
  const payload = JSON.stringify(obj);
  for (const member of room.members.values()) {
    if (member.id === exceptId) continue;
    try {
      member.ws.send(payload);
    } catch {
      // ignore
    }
  }
}

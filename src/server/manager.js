import { Match } from '../engine/match.js';
import { MatchError, resolveConfig } from '../engine/config.js';

export class MatchManager {
  constructor({ now = () => Date.now(), maxRooms = 4 } = {}) {
    if (!Number.isInteger(maxRooms) || maxRooms <= 0) {
      throw new Error('maxRooms 必须是正整数');
    }
    this.now = now;
    this.maxRooms = maxRooms;
    this.matches = new Map();
    this.tickTimer = null;
    this.listeners = new Map();
    this.sequence = 0;
    this.lastTickAt = this.now();
    this.closedRooms = [];
  }

  create({ name, config } = {}) {
    if (this.matches.size >= this.maxRooms) {
      throw new MatchError(409, `房间数量已达上限（${this.maxRooms}）`, 'room_limit');
    }
    this.sequence += 1;
    const id = `m${this.sequence}`;
    const cleanName = String(name || '').trim().slice(0, 40) || `对局 ${id}`;
    const match = new Match(id, { name: cleanName, config, nowMs: this.now() });
    this.matches.set(id, match);
    this.emitChange(match, 'created');
    return match;
  }

  get(id) {
    const match = this.matches.get(id);
    if (!match) throw new MatchError(404, '对局不存在', 'unknown_match');
    return match;
  }

  list() {
    return [...this.matches.values()].map((match) => ({
      id: match.id,
      name: match.name,
      phase: match.phase,
      players: match.entities.size,
      owner: match.owner,
      progress: round1(match.progress),
      scores: { ...match.scores },
      elapsedMs: Math.round(match.elapsedMs),
      remainingMs: Math.round(match.remainingMs)
    }));
  }

  // 房间关闭的固定次序：
  // 1) 快照最终状态与事件/关键帧容量统计；
  // 2) 通知所有 SSE 订阅者房间关闭并断开流；
  // 3) 注销订阅集合，再把房间移出调度表（后续 tick 不会再驱动它）。
  closeRoom(id, reason = 'closed') {
    const match = this.get(id);
    const recorderStats = match.recorder.stats();
    const summary = {
      matchId: match.id,
      name: match.name,
      reason,
      phase: match.phase,
      winner: match.leaderboardWinner(),
      endReason: match.endReason,
      finalScores: { ...match.scores },
      playersJoined: match.nextPlayerNumber,
      presenceAtClose: match.presence.size,
      createdAtMs: match.createdAtMs,
      startedAtMs: match.startedAtMs,
      endedAtMs: match.endedAtMs,
      closedAtMs: this.now(),
      recorder: recorderStats
    };
    this.notifyClosed(match, reason);
    this.listeners.delete(match.id);
    this.matches.delete(match.id);
    this.closedRooms.push(summary);
    return summary;
  }

  // 兼容旧接口名：显式销毁单个房间。
  remove(id, reason = 'closed') {
    return this.closeRoom(id, reason);
  }

  // 实例关停：先停全局时钟，再按房间创建次序逐间清理，最后确认没有残留订阅与房间。
  shutdown(reason = 'shutdown') {
    const report = {
      reason,
      at: this.now(),
      maxRooms: this.maxRooms,
      stoppedClock: false,
      rooms: [],
      remainingRooms: null,
      remainingSubscriptions: null
    };
    if (this.tickTimer) {
      this.stopClock();
      report.stoppedClock = true;
    }
    for (const id of [...this.matches.keys()]) {
      report.rooms.push(this.closeRoom(id, reason));
    }
    report.remainingRooms = this.matches.size;
    report.remainingSubscriptions = [...this.listeners.values()].reduce(
      (sum, set) => sum + set.size,
      0
    );
    return report;
  }

  stats() {
    const phases = { lobby: 0, running: 0, ended: 0 };
    let events = 0;
    let frames = 0;
    let droppedEvents = 0;
    let droppedFrames = 0;
    for (const match of this.matches.values()) {
      phases[match.phase] += 1;
      const s = match.recorder.stats();
      events += s.events;
      frames += s.frames;
      droppedEvents += s.droppedEvents;
      droppedFrames += s.droppedFrames;
    }
    return {
      rooms: this.matches.size,
      maxRooms: this.maxRooms,
      phases,
      closedRoomCount: this.closedRooms.length,
      subscriptions: [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0),
      bufferedEvents: events,
      bufferedFrames: frames,
      droppedEvents,
      droppedFrames
    };
  }

  subscribe(matchId, listener, sinceSeq = 0) {
    if (!this.listeners.has(matchId)) this.listeners.set(matchId, new Set());
    const entry = {
      lastSeq: sinceSeq,
      listener,
      lastSnapshot: null,
      lastSnapshotRev: -1,
      lastStateAt: 0
    };
    this.listeners.get(matchId).add(entry);
    return () => {
      const set = this.listeners.get(matchId);
      if (!set) return;
      set.delete(entry);
      if (set.size === 0) this.listeners.delete(matchId);
    };
  }

  notifyClosed(match, reason) {
    const entries = this.listeners.get(match.id);
    if (!entries) return;
    const payload = {
      closed: true,
      cause: 'room_closed',
      reason,
      matchId: match.id,
      snapshot: match.snapshot()
    };
    for (const entry of [...entries]) {
      try {
        entry.listener(payload);
      } catch {
        // 订阅者已断开，不影响清理次序。
      }
    }
  }

  emitChange(match, cause) {
    const entries = this.listeners.get(match.id);
    if (!entries) return;
    for (const entry of entries) {
      let events;
      try {
        events = match.recorder.eventsSince(entry.lastSeq);
      } catch {
        events = [];
      }
      // 只向该订阅者推送它尚未收到的增量事件，避免重复回放。
      const lastDelivered = events.length > 0 ? events[events.length - 1].seq : entry.lastSeq;
      const now = this.now();
      const throttleMs = 100;
      const stateDue =
        events.length > 0 ||
        (entry.lastSnapshotRev !== match.revision && now - entry.lastStateAt >= throttleMs);
      if (!stateDue && events.length === 0) continue;
      const payload = {
        cause,
        revision: match.revision,
        matchId: match.id,
        eventSeq: match.eventSeq,
        snapshot: stateDue ? match.snapshot() : entry.lastSnapshot,
        events
      };
      try {
        entry.listener(payload);
        entry.lastSeq = lastDelivered;
        if (stateDue) {
          entry.lastSnapshotRev = match.revision;
          entry.lastSnapshot = payload.snapshot;
          entry.lastStateAt = now;
        }
      } catch {
        // SSE 客户端断开不影响对局推进。
      }
    }
  }

  tick(nowMs = this.now()) {
    const delta = nowMs - this.lastTickAt;
    this.lastTickAt = nowMs;
    if (delta < 0) return;
    for (const match of this.matches.values()) {
      if (match.phase !== 'running') continue;
      match.step(nowMs);
      this.emitChange(match, 'tick');
    }
  }

  startClock(intervalMs = 50) {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), intervalMs);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  stopClock() {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export { resolveConfig };

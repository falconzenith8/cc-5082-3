import { Match } from '../engine/match.js';
import { MatchError, resolveConfig } from '../engine/config.js';

export class MatchManager {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.matches = new Map();
    this.tickTimer = null;
    this.listeners = new Map();
    this.sequence = 0;
    this.lastTickAt = this.now();
  }

  create({ name, config } = {}) {
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

  remove(id) {
    const match = this.matches.get(id);
    if (!match) throw new MatchError(404, '对局不存在', 'unknown_match');
    this.matches.delete(id);
    this.listeners.delete(id);
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
        entry.lastSnapshotRev !== match.revision &&
        now - entry.lastStateAt >= throttleMs;
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

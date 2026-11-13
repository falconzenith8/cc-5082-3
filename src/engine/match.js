import { FACTIONS, MatchError, ROLES, resolveConfig } from './config.js';
import { EventRecorder } from './events.js';
import {
  computePresenceWeights,
  decayTowardPole,
  deriveMomentum,
  memberEligibility
} from './capture.js';
import { PresenceTracker } from './presence.js';
import { clamp, rectContainsCircle } from './util.js';

const FACTION_IDS = Object.keys(FACTIONS);
const IDLE_MOMENTUM = {
  kind: 'idle',
  direction: null,
  net: 0,
  speed: 0,
  mode: 'hold',
  reason: '对局尚未开始'
};

export class Match {
  constructor(id, { name = '据点争夺', config = {}, nowMs = Date.now() } = {}) {
    this.id = id;
    this.name = name;
    this.config = resolveConfig(config);
    this.createdAtMs = nowMs;
    this.clockMs = nowMs;
    this.lastStepMs = nowMs;
    this.phase = 'lobby';
    this.startedAtMs = null;
    this.endedAtMs = null;
    this.endedAtElapsedMs = null;
    this.endReason = null;
    this.revision = 0;
    this.nextPlayerNumber = 0;
    this.identitySerial = 0;

    this.presence = new PresenceTracker(this.config.point);
    this.entities = new Map();
    this.owner = null;
    this.progress = 0;
    this.challenger = null;
    this.scores = Object.fromEntries(FACTION_IDS.map((id) => [id, 0]));
    this.scoreBucket = 0;

    this.recorder = new EventRecorder(this.config.eventLimit, this.config.frameLimit);
    this.recentEvents = [];
    this.eventSeq = 1;
    this.lastMomentum = IDLE_MOMENTUM;
    this.lastFrameAtMs = 0;
  }

  get elapsedMs() {
    if (this.startedAtMs === null) return 0;
    const end = this.endedAtMs ?? this.clockMs;
    return Math.max(0, end - this.startedAtMs);
  }

  get remainingMs() {
    return Math.max(0, this.config.durationMs - this.elapsedMs);
  }

  // ---- 玩家生命周期 ----

  addPlayer({ faction, role = 'vanguard', name }, nowMs = Date.now()) {
    if (this.phase === 'ended') throw new MatchError(409, '对局已结束，拒绝迟到加入', 'match_ended');
    if (!FACTION_IDS.includes(faction)) throw new MatchError(400, '无效阵营', 'invalid_faction');
    if (!ROLES[role]) throw new MatchError(400, '无效角色', 'invalid_role');
    if (this.entities.size >= this.config.maxPlayersTotal) {
      throw new MatchError(409, '对局人数已满', 'match_full');
    }
    const factionCount = this.countFaction(faction);
    if (factionCount >= this.config.maxPlayersPerFaction) {
      throw new MatchError(409, '该阵营人数已满', 'faction_full');
    }

    this.nextPlayerNumber += 1;
    const playerId = `p${this.nextPlayerNumber}`;
    const cleanName = String(name || '').trim().slice(0, 24) || `${FACTIONS[faction].name}${factionCount + 1}`;
    const spawn = this.config.spawns[faction];
    const entity = {
      id: playerId,
      playerId,
      slot: `${faction}${factionCount + 1}`,
      generation: 1,
      faction,
      role,
      name: cleanName,
      x: spawn.x,
      y: spawn.y,
      hp: this.config.hpMax,
      alive: true,
      suppressedUntilMs: 0,
      respawnAtMs: null,
      cooldownUntilMs: 0,
      target: null
    };
    this.entities.set(playerId, entity);
    this.emit('player_joined', nowMs, {
      playerId,
      faction,
      role,
      roleName: ROLES[role].name,
      name: cleanName,
      slot: entity.slot,
      generation: entity.generation
    });
    this.revision += 1;
    return entity;
  }

  countFaction(faction) {
    let count = 0;
    for (const entity of this.entities.values()) {
      if (entity.faction === faction) count += 1;
    }
    return count;
  }

  removePlayer(playerId, nowMs = Date.now()) {
    const entity = this.entities.get(playerId);
    if (!entity) throw new MatchError(404, '玩家不存在', 'unknown_player');
    const record = this.presence.release(playerId);
    this.entities.delete(playerId);
    if (record) {
      this.emit('presence_exit', nowMs, {
        playerId,
        faction: record.faction,
        slot: record.slot,
        generation: record.generation,
        reason: 'left'
      });
    }
    this.emit('player_left', nowMs, {
      playerId,
      faction: entity.faction,
      name: entity.name,
      slot: entity.slot
    });
    this.revision += 1;
    if (this.phase === 'running') {
      this.syncPresence(nowMs);
      this.refreshMomentum(nowMs);
      this.emit('participants_reinterpreted', nowMs, {
        reason: 'player_left',
        playerId,
        eligible: Object.fromEntries(
          FACTION_IDS.map((faction) => [faction, this.lastMomentum.weights[faction] ?? 0])
        )
      });
    }
    return entity;
  }

  setFaction(playerId, faction, nowMs = Date.now()) {
    if (this.phase === 'ended') throw new MatchError(409, '对局已结束', 'match_ended');
    const entity = this.entities.get(playerId);
    if (!entity) throw new MatchError(404, '玩家不存在', 'unknown_player');
    if (!FACTION_IDS.includes(faction)) throw new MatchError(400, '无效阵营', 'invalid_faction');
    if (entity.faction === faction) return entity;

    const previous = entity.faction;
    entity.faction = faction;
    entity.slot = `${faction}${this.countFaction(faction) + 1}`;
    // 切换阵营视为退出旧阵营的参与记录，下一 tick 以新阵营重新参与资格计算。
    const record = this.presence.release(playerId);
    if (record) {
      this.emit('presence_exit', nowMs, {
        playerId,
        faction: previous,
        slot: record.slot,
        generation: record.generation,
        reason: 'faction_switch'
      });
    }
    this.emit('faction_switch', nowMs, {
      playerId,
      from: previous,
      to: faction,
      name: entity.name,
      generation: entity.generation
    });
    this.revision += 1;
    if (this.phase === 'running') {
      this.syncPresence(nowMs);
      this.refreshMomentum(nowMs);
      // 换阵营后按新身份重新解释有效参与者，而不是把新旧阵营人数相减。
      this.emit('participants_reinterpreted', nowMs, {
        reason: 'faction_switch',
        playerId,
        from: previous,
        to: faction,
        eligible: Object.fromEntries(
          FACTION_IDS.map((id) => [id, this.lastMomentum.weights[id] ?? 0])
        )
      });
    }
    return entity;
  }

  // ---- 输入 ----

  command(playerId, command, nowMs = Date.now()) {
    if (this.phase !== 'running') throw new MatchError(409, '对局未进行中', 'match_not_running');
    const entity = this.entities.get(playerId);
    if (!entity) throw new MatchError(404, '玩家不存在', 'unknown_player');
    // 对象身份复用：复活或换阵营会推进 generation，携带旧身份的指令必须被拒绝。
    if (command?.generation !== undefined && command.generation !== entity.generation) {
      throw new MatchError(409, '对象身份已更新，拒绝过期指令', 'stale_identity');
    }
    if (!entity.alive) throw new MatchError(409, '角色未存活', 'not_alive');
    if (nowMs < 0) throw new MatchError(400, '无效时间', 'invalid_time');

    const type = command?.type;
    if (type === 'move') {
      const target = command.target || {};
      const x = Number(target.x);
      const y = Number(target.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new MatchError(400, '无效移动目标', 'invalid_target');
      const margin = this.config.map.margin;
      entity.target = {
        x: clamp(x, margin, this.config.map.width - margin),
        y: clamp(y, margin, this.config.map.height - margin)
      };
    } else if (type === 'stop') {
      entity.target = null;
    } else if (type === 'fire') {
      this.fire(playerId, command.targetPlayerId, nowMs);
    } else {
      throw new MatchError(400, '未知指令', 'unknown_command');
    }
    this.revision += 1;
    return true;
  }

  fire(playerId, targetPlayerId, nowMs) {
    const attacker = this.entities.get(playerId);
    if (!attacker || !attacker.alive) throw new MatchError(409, '角色未存活', 'not_alive');
    if (attacker.cooldownUntilMs > nowMs) throw new MatchError(429, '射击冷却中', 'cooldown');
    const target = this.entities.get(targetPlayerId);
    if (!target || !target.alive) throw new MatchError(404, '目标不存在', 'unknown_target');
    if (target.faction === attacker.faction) throw new MatchError(400, '不能攻击同阵营', 'friendly_fire');
    if (Math.hypot(target.x - attacker.x, target.y - attacker.y) > this.config.fire.range) {
      throw new MatchError(400, '目标超出射程', 'out_of_range');
    }

    attacker.cooldownUntilMs = nowMs + this.config.fire.cooldownMs;
    if (attacker.suppressedUntilMs > nowMs) {
      // 被压制的角色仍可还击，但不能占领；射击不解除压制。
      attacker.suppressedUntilMs = Math.max(attacker.suppressedUntilMs, nowMs);
    }
    target.hp -= this.config.fire.damage;
    target.suppressedUntilMs = Math.max(target.suppressedUntilMs, nowMs + this.config.fire.suppressMs);
    this.emit('hit', nowMs, {
      attacker: playerId,
      target: targetPlayerId,
      faction: attacker.faction,
      targetFaction: target.faction,
      damage: this.config.fire.damage,
      hp: Math.max(0, target.hp),
      suppressedMs: this.config.fire.suppressMs
    });

    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.target = null;
      target.respawnAtMs = nowMs + this.config.respawnMs;
      const record = this.presence.release(target.playerId);
      this.emit('down', nowMs, {
        playerId: target.playerId,
        by: playerId,
        faction: target.faction,
        slot: target.slot,
        generation: target.generation,
        presenceReleased: Boolean(record),
        respawnAtMs: target.respawnAtMs
      });
    }
    if (this.phase === 'running') this.step(nowMs);
  }

  // ---- 对局推进 ----

  start(nowMs = Date.now()) {
    if (this.phase !== 'lobby') throw new MatchError(409, '对局已经开始或结束', 'invalid_phase');
    if (this.entities.size === 0) throw new MatchError(409, '至少需要一名玩家', 'no_players');
    this.phase = 'running';
    this.startedAtMs = nowMs;
    this.clockMs = nowMs;
    this.lastStepMs = nowMs;
    this.scoreBucket = 1;
    this.emit('match_start', nowMs, {
      durationMs: this.config.durationMs,
      scoreToWin: this.config.scoreToWin,
      scoreIntervalMs: this.config.scoreIntervalMs
    });
    this.captureFrame(nowMs, true);
    this.revision += 1;
  }

  end(reason, nowMs = Date.now()) {
    if (this.phase !== 'running') return false;
    this.endedAtMs = nowMs;
    this.endedAtElapsedMs = this.elapsedMs;
    this.endReason = reason;
    this.phase = 'ended';
    const winner = this.leaderboardWinner();
    this.emit('match_end', nowMs, {
      reason,
      winner,
      scores: { ...this.scores },
      elapsedMs: this.endedAtElapsedMs
    });
    this.captureFrame(nowMs, true);
    this.revision += 1;
    return true;
  }

  leaderboardWinner() {
    const rows = FACTION_IDS
      .map((faction) => ({ faction, score: this.scores[faction] }))
      .sort((a, b) => b.score - a.score);
    if (rows.length < 2) return rows[0]?.score > 0 ? rows[0].faction : null;
    if (rows[0].score === 0) return null;
    if (rows[0].score === rows[1].score) return null;
    return rows[0].faction;
  }

  awardScore(factionId, amount, reason, nowMs, meta = {}) {
    // 胜利条件达成后对局转为 ended，这里拒绝所有延迟到达的旧计分回调。
    if (this.phase !== 'running') return null;
    if (!FACTION_IDS.includes(factionId)) return null;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    this.scores[factionId] += amount;
    const event = this.emit('score', nowMs, {
      faction: factionId,
      amount,
      total: this.scores[factionId],
      reason,
      ...meta
    });
    if (this.scores[factionId] >= this.config.scoreToWin) {
      this.end('score', nowMs);
    }
    return event;
  }

  processHoldScore(boundaryMs) {
    if (this.phase !== 'running') return;
    if (!this.owner) {
      // 无人控制且据点内确有角色在争夺时，仍显式记录该节点未结算。
      const kind = this.lastMomentum.kind;
      if (kind === 'contested' || kind === 'deadlock' || kind === 'solo') {
        this.emit('hold_skipped', boundaryMs, { reason: 'unowned', bucket: this.scoreBucket });
      }
      return;
    }
    if (this.challenger !== null || this.progress > 0) {
      this.emit('hold_skipped', boundaryMs, {
        faction: this.owner,
        reason: 'under_contest',
        bucket: this.scoreBucket
      });
      return;
    }
    const weights = this.lastMomentum.weights || {};
    const ownerWeight = weights[this.owner] ?? 0;
    if (ownerWeight <= 0) {
      // 空场：控制方无人留在据点，占领条回落但计分节点不计分。
      this.emit('hold_skipped', boundaryMs, {
        faction: this.owner,
        reason: 'owner_absent',
        bucket: this.scoreBucket
      });
      return;
    }
    // 据点内任何存活敌对成员都会打断固守结算，即使其角色没有占领资格。
    const contest = this.lastMomentum.contestWeights || {};
    const rivalContest = Object.keys(contest).reduce(
      (sum, faction) => (faction === this.owner ? sum : sum + (contest[faction] ?? 0)),
      0
    );
    if (rivalContest > 0) {
      this.emit('hold_skipped', boundaryMs, {
        faction: this.owner,
        reason: 'contested_presence',
        bucket: this.scoreBucket
      });
      return;
    }
    this.awardScore(this.owner, this.config.holdPointsPerSec, 'hold', boundaryMs, {
      bucket: this.scoreBucket
    });
  }

  step(nowMs = Date.now()) {
    this.clockMs = nowMs;
    if (this.phase !== 'running') {
      this.lastStepMs = nowMs;
      return this.snapshot();
    }

    const rawDelta = nowMs - this.lastStepMs;
    const delta = Math.max(0, Math.min(this.config.maxStepMs, rawDelta));
    this.lastStepMs = nowMs;
    if (delta > 0) {
      this.advanceMovement(delta, nowMs);
      this.respawnDead(nowMs);
    }
    // 即使时间没有推进，也要按当前参与记录重算资格与动量，保证指令后的快照一致。
    this.syncPresence(nowMs);
    this.refreshMomentum(nowMs);
    if (delta > 0) {
      this.advanceCapture(delta / 1000, nowMs);
      this.tickScoreBoundaries(nowMs);
    }
    if (this.phase === 'running') this.tickTimeLimit(nowMs);
    this.captureFrame(nowMs, false);
    this.revision += 1;
    return this.snapshot();
  }

  refreshMomentum(nowMs) {
    const eligibility = computePresenceWeights(
      FACTION_IDS,
      this.entities,
      this.presence.list(),
      nowMs
    );
    const momentum = deriveMomentum(
      eligibility.factions,
      eligibility.present,
      eligibility.eligible,
      this.config.contestedFactor
    );
    momentum.weights = Object.fromEntries(
      FACTION_IDS.map((faction) => [faction, eligibility.factions[faction]?.capture ?? 0])
    );
    momentum.contestWeights = Object.fromEntries(
      FACTION_IDS.map((faction) => [faction, eligibility.factions[faction]?.contest ?? 0])
    );
    momentum.speed = 0;
    momentum.mode = 'hold';
    this.lastMomentum = momentum;
    return momentum;
  }

  advanceCapture(dtSeconds, nowMs) {
    const momentum = this.lastMomentum;
    const eligibilityCount = Object.values(momentum.weights || {}).filter((w) => w > 0).length;
    momentum.eligibleCount = eligibilityCount;

    if (momentum.kind === 'empty' || momentum.kind === 'pinned' || momentum.kind === 'deadlock') {
      this.coastTowardNeutral(dtSeconds, momentum);
      return;
    }

    if (momentum.kind === 'solo' && momentum.direction === this.owner) {
      // 控制方独自在场：修复此前的争夺进度，控制权不受影响。
      momentum.mode = 'recover';
      momentum.speed = -this.config.decayRate;
      this.coastTowardNeutral(dtSeconds, momentum);
      return;
    }

    if (momentum.kind === 'contested' && momentum.direction === this.owner) {
      // 控制方在争夺中以净权重占优：逐步压下挑战进度。
      momentum.mode = 'defend';
      momentum.speed = -this.config.decayRate;
      this.coastTowardNeutral(dtSeconds, momentum);
      return;
    }

    const pusher = momentum.direction;
    const magnitude = momentum.magnitude;
    if (this.challenger !== pusher) {
      // 新的挑战方从零开始，不能继承前任占领进度。
      this.challenger = pusher;
      this.progress = 0;
    }
    momentum.mode = momentum.kind === 'contested' ? 'contested_push' : 'push';
    momentum.speed = magnitude * this.config.captureRate;
    this.progress = clamp(this.progress + momentum.speed * dtSeconds, 0, 100);

    if (this.progress >= 100) {
      this.resolveCapture(pusher, nowMs);
    }
  }

  tickTimeLimit(nowMs) {
    if (this.phase !== 'running') return;
    const boundary = this.startedAtMs + this.config.durationMs;
    // 结算时间截断在比赛预算边界，不把超出的墙钟时间算进对局时长。
    if (nowMs >= boundary) this.end('timeout', boundary);
  }

  syncPresence(nowMs) {
    const { entered, exited } = this.presence.sync(this.entities, nowMs);
    for (const entity of entered) {
      this.emit('presence_enter', nowMs, {
        playerId: entity.playerId,
        faction: entity.faction,
        slot: entity.slot,
        generation: entity.generation,
        name: entity.name,
        role: entity.role
      });
    }
    for (const record of exited) {
      this.emit('presence_exit', nowMs, {
        playerId: record.entityId,
        faction: record.faction,
        slot: record.slot,
        generation: record.generation,
        reason: 'moved_out'
      });
    }
    return { entered, exited };
  }

  coastTowardNeutral(dtSeconds, momentum) {
    this.progress = decayTowardPole(this.progress, 0, this.config.decayRate, dtSeconds);
    if (this.progress === 0) {
      this.challenger = null;
      if (momentum.mode !== 'push' && momentum.mode !== 'contested_push') {
        momentum.mode = 'decay';
      }
    }
  }

  resolveCapture(factionId, nowMs) {
    const previous = this.owner;
    this.owner = factionId;
    this.progress = 0;
    this.challenger = null;
    this.emit('captured', nowMs, {
      faction: factionId,
      fromFaction: previous,
      progressReset: 0
    });
    this.awardScore(factionId, this.config.captureBonus, 'capture', nowMs, {
      fromFaction: previous
    });
  }

  tickScoreBoundaries(nowMs) {
    if (this.startedAtMs === null) return;
    const horizon = Math.min(nowMs, this.startedAtMs + this.config.durationMs);
    let boundary = this.startedAtMs + this.scoreBucket * this.config.scoreIntervalMs;
    let guard = 0;
    while (boundary <= horizon && guard < 10000) {
      guard += 1;
      if (this.phase !== 'running') return;
      this.processHoldScore(boundary);
      this.scoreBucket += 1;
      boundary = this.startedAtMs + this.scoreBucket * this.config.scoreIntervalMs;
    }
  }

  advanceMovement(deltaMs, nowMs) {
    const dt = deltaMs / 1000;
    for (const entity of this.entities.values()) {
      if (!entity.alive || !entity.target) continue;
      const factor = entity.suppressedUntilMs > nowMs ? this.config.suppressedMoveFactor : 1;
      const dx = entity.target.x - entity.x;
      const dy = entity.target.y - entity.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 1e-6) {
        entity.target = null;
        continue;
      }
      const travel = Math.min(distance, this.config.moveSpeed * factor * dt);
      const nx = entity.x + (dx / distance) * travel;
      const ny = entity.y + (dy / distance) * travel;
      const solved = this.collide(nx, ny);
      entity.x = solved.x;
      entity.y = solved.y;
      if (travel >= distance) entity.target = null;
    }
  }

  collide(nx, ny) {
    const margin = this.config.map.margin;
    const radius = this.config.playerRadius;
    let x = clamp(nx, margin, this.config.map.width - margin);
    let y = clamp(ny, margin, this.config.map.height - margin);
    for (const rect of this.config.obstacles) {
      if (!rectContainsCircle(x, y, radius, rect)) continue;
      const pushLeft = x + radius - rect.x;
      const pushRight = rect.x + rect.w - (x - radius);
      const pushTop = y + radius - rect.y;
      const pushBottom = rect.y + rect.h - (y - radius);
      const min = Math.min(pushLeft, pushRight, pushTop, pushBottom);
      if (min === pushLeft) x = rect.x - radius;
      else if (min === pushRight) x = rect.x + rect.w + radius;
      else if (min === pushTop) y = rect.y - radius;
      else y = rect.y + rect.h + radius;
    }
    return { x, y };
  }

  respawnDead(nowMs) {
    for (const entity of this.entities.values()) {
      if (entity.alive || entity.respawnAtMs === null || nowMs < entity.respawnAtMs) continue;
      const spawn = this.config.spawns[entity.faction];
      entity.generation += 1;
      entity.alive = true;
      entity.hp = this.config.hpMax;
      entity.suppressedUntilMs = 0;
      entity.respawnAtMs = null;
      entity.cooldownUntilMs = 0;
      entity.target = null;
      entity.x = spawn.x;
      entity.y = spawn.y;
      this.identitySerial += 1;
      this.emit('respawn', nowMs, {
        playerId: entity.playerId,
        faction: entity.faction,
        slot: entity.slot,
        generation: entity.generation,
        identitySerial: this.identitySerial,
        x: spawn.x,
        y: spawn.y
      });
    }
  }

  // ---- 输出 ----

  emit(type, atMs, data = {}) {
    const offset = this.startedAtMs === null ? 0 : Math.max(0, atMs - this.startedAtMs);
    const event = this.recorder.push(type, offset, data);
    event.revision = this.revision;
    event.matchId = this.id;
    this.recentEvents.push(event);
    if (this.recentEvents.length > 120) this.recentEvents.shift();
    this.eventSeq = event.seq + 1;
    return event;
  }

  captureFrame(nowMs, force) {
    const elapsed = this.elapsedMs;
    if (!force && elapsed - this.lastFrameAtMs < this.config.keyframeIntervalMs) return;
    this.lastFrameAtMs = elapsed;
    const eligibility = computePresenceWeights(
      FACTION_IDS,
      this.entities,
      this.presence.list(),
      nowMs
    );
    this.recorder.frame(
      {
        phase: this.phase,
        owner: this.owner,
        progress: round1(this.progress),
        challenger: this.challenger,
        momentum: {
          kind: this.lastMomentum.kind,
          direction: this.lastMomentum.direction,
          speed: round1(this.lastMomentum.speed ?? 0),
          mode: this.lastMomentum.mode,
          net: round1(this.lastMomentum.net ?? 0)
        },
        scores: { ...this.scores },
        presence: this.presence.list().map((record) => {
          const entity = this.entities.get(record.entityId);
          const row = entity ? memberEligibility(entity, nowMs, entity.faction) : null;
          return {
            playerId: record.entityId,
            name: record.name,
            faction: record.faction,
            slot: record.slot,
            generation: record.generation,
            role: record.role,
            status: row?.status ?? 'unknown',
            captureWeight: row?.capture ?? 0
          };
        }),
        factions: eligibility.factions,
        players: [...this.entities.values()].map((entity) => ({
          id: entity.id,
          faction: entity.faction,
          role: entity.role,
          x: round1(entity.x),
          y: round1(entity.y),
          alive: entity.alive,
          hp: Math.max(0, entity.hp),
          generation: entity.generation,
          suppressed: entity.suppressedUntilMs > nowMs
        }))
      },
      elapsed
    );
  }

  snapshot() {
    const nowMs = this.clockMs;
    const eligibility = computePresenceWeights(
      FACTION_IDS,
      this.entities,
      this.presence.list(),
      nowMs
    );
    return {
      id: this.id,
      name: this.name,
      phase: this.phase,
      revision: this.revision,
      elapsedMs: Math.round(this.elapsedMs),
      remainingMs: Math.round(this.remainingMs),
      durationMs: this.config.durationMs,
      scoreIntervalMs: this.config.scoreIntervalMs,
      scoreToWin: this.config.scoreToWin,
      owner: this.owner,
      progress: round1(this.progress),
      challenger: this.challenger,
      momentum: {
        kind: this.lastMomentum.kind,
        direction: this.lastMomentum.direction,
        magnitude: round1(this.lastMomentum.magnitude ?? 0),
        net: round1(this.lastMomentum.net ?? 0),
        speed: round1(this.lastMomentum.speed ?? 0),
        mode: this.lastMomentum.mode ?? 'hold',
        reason: this.lastMomentum.reason,
        weights: this.lastMomentum.weights || {},
        contenders: this.lastMomentum.contenders || []
      },
      scores: { ...this.scores },
      scoreBucket: this.scoreBucket,
      factions: eligibility.factions,
      presence: this.presence.list().map((record) => {
        const entity = this.entities.get(record.entityId);
        const row = entity ? memberEligibility(entity, nowMs, entity.faction) : null;
        return {
          playerId: record.entityId,
          name: record.name,
          faction: record.faction,
          slot: record.slot,
          generation: record.generation,
          enteredAtElapsedMs: this.startedAtMs === null ? 0 : Math.max(0, record.enteredAtMs - this.startedAtMs),
          status: row?.status ?? 'unknown',
          captureWeight: row?.capture ?? 0,
          role: record.role
        };
      }),
      players: [...this.entities.values()].map((entity) => this.playerView(entity, nowMs)),
      map: this.config.map,
      point: this.config.point,
      spawns: this.config.spawns,
      obstacles: this.config.obstacles,
      roles: Object.fromEntries(
        Object.entries(ROLES).map(([id, role]) => [
          id,
          {
            id,
            name: role.name,
            short: role.short,
            captureWeight: role.captureWeight,
            canCapture: role.canCapture,
            description: role.description
          }
        ])
      ),
      endReason: this.endReason,
      endedAtElapsedMs: this.endedAtElapsedMs
    };
  }

  playerView(entity, nowMs) {
    const eligibility = memberEligibility(entity, nowMs, entity.faction);
    return {
      id: entity.id,
      playerId: entity.playerId,
      name: entity.name,
      faction: entity.faction,
      role: entity.role,
      roleName: eligibility.roleName,
      roleShort: eligibility.roleShort,
      slot: entity.slot,
      generation: entity.generation,
      x: round1(entity.x),
      y: round1(entity.y),
      hp: Math.max(0, entity.hp),
      alive: entity.alive,
      suppressed: eligibility.suppressed,
      suppressedRemainingMs: Math.max(0, Math.round(entity.suppressedUntilMs - nowMs)),
      captureWeight: eligibility.capture,
      status: eligibility.status,
      respawnInMs: entity.alive ? 0 : Math.max(0, Math.round((entity.respawnAtMs ?? nowMs) - nowMs)),
      inside: this.presence.has(entity.id),
      target: entity.target ? { x: round1(entity.target.x), y: round1(entity.target.y) } : null
    };
  }

  replayData() {
    const meta = this.recorder.replayPayload({
      id: this.id,
      name: this.name,
      createdAtMs: this.createdAtMs,
      startedAtMs: this.startedAtMs,
      endedAtMs: this.endedAtMs,
      phase: this.phase,
      endReason: this.endReason,
      owner: this.owner,
      scores: { ...this.scores },
      durationMs: this.config.durationMs,
      scoreToWin: this.config.scoreToWin,
      map: this.config.map,
      point: this.config.point,
      spawns: this.config.spawns,
      obstacles: this.config.obstacles,
      roles: this.snapshot().roles
    });
    // 回放包顶层直接给出地图与规则，播放器无需再解引用嵌套字段。
    return {
      ...meta.meta,
      events: meta.events,
      frames: meta.frames,
      meta: meta.meta
    };
  }
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

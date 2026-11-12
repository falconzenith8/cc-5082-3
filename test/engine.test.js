import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/engine/match.js';
import { resolveConfig } from '../src/engine/config.js';

const POINT_CONFIG = {
  map: { width: 900, height: 900, margin: 20 },
  point: { x: 450, y: 450, radius: 120 },
  spawns: {
    A: { x: 450, y: 450 },
    B: { x: 450, y: 450 },
    C: { x: 450, y: 450 }
  },
  obstacles: [],
  captureRate: 20,
  decayRate: 10,
  contestedFactor: 0.5,
  captureBonus: 25,
  holdPointsPerSec: 3,
  scoreIntervalMs: 1000,
  scoreToWin: 500,
  durationMs: 300000,
  respawnMs: 12000,
  moveSpeed: 0,
  fire: { range: 1000, damage: 22, cooldownMs: 0, suppressMs: 2000 }
};

function makeMatch(overrides = {}) {
  const match = new Match('test', { config: { ...POINT_CONFIG, ...overrides }, nowMs: 0 });
  return match;
}

function addAtPoint(match, faction, role = 'vanguard', name = faction) {
  const entity = match.addPlayer({ faction, role, name }, 0);
  entity.x = match.config.point.x;
  entity.y = match.config.point.y;
  return entity;
}

function runSteps(match, fromMs, toMs, stepMs = 50) {
  for (let t = fromMs; t <= toMs; t += stepMs) {
    match.step(t);
  }
  return match.snapshot();
}

test('最后一人在计分节点前离开据点：空场进度回落且该节点不计分', () => {
  const match = makeMatch({ scoreToWin: 1000 });
  const a = addAtPoint(match, 'A');
  match.start(0);
  let snapshot = runSteps(match, 50, 6000);
  assert.equal(snapshot.owner, 'A');
  assert.equal(snapshot.progress, 0);
  const captured = match.recorder.events.filter((e) => e.type === 'captured').length;
  assert.equal(captured, 1);

  const scoreBefore = snapshot.scores.A;
  assert.ok(scoreBefore > 0);

  // 最后一人离场，空场推进规律：进度回落；计分节点不得继续记分。
  a.x = 100;
  a.y = 100;
  const before = match.recorder.events.length;
  snapshot = runSteps(match, 6000 + 50, 6000 + 4000);
  const eventsSince = match.recorder.events.slice(before);
  assert.equal(snapshot.owner, 'A', '空场不立即丢失控制权');
  assert.equal(snapshot.momentum.kind, 'empty');
  const skipped = eventsSince.filter((e) => e.type === 'hold_skipped' && e.reason === 'owner_absent');
  assert.ok(skipped.length >= 1, '空场计分节点应显式跳过');
  const scoreAfter = snapshot.scores.A;
  assert.equal(scoreAfter, scoreBefore, '空场期间不得继续得分');
});

test('两方同时进入据点：有效权重相抵，无人推进且计分跳过', () => {
  const match = makeMatch({ scoreToWin: 1000 });
  addAtPoint(match, 'A', 'vanguard');
  addAtPoint(match, 'B', 'vanguard');
  match.start(0);
  const snapshot = runSteps(match, 50, 5000);
  assert.equal(snapshot.momentum.kind, 'deadlock');
  assert.equal(snapshot.progress, 0);
  assert.equal(snapshot.owner, null);
  const skipped = match.recorder.events.filter((e) => e.type === 'hold_skipped');
  assert.ok(skipped.length >= 4, '每个节点都应跳过计分');
  for (const event of skipped) {
    assert.ok(['unowned', 'contested_presence', 'under_contest'].includes(event.reason));
  }
  assert.equal(snapshot.scores.A + snapshot.scores.B, 0);
});

test('多方争夺出现净优势时按净值推进，而不是简单清零', () => {
  const match = makeMatch({ scoreToWin: 1000 });
  addAtPoint(match, 'A', 'engineer');
  addAtPoint(match, 'B', 'vanguard');
  addAtPoint(match, 'C', 'support');
  match.start(0);
  const snapshot = runSteps(match, 50, 400);
  // A 权重 1.5，B 权重 1，C 无占领资格 -> 净 0.5 * contestedFactor 0.5 = 0.25
  assert.equal(snapshot.momentum.kind, 'contested');
  assert.equal(snapshot.momentum.direction, 'A');
  assert.equal(snapshot.momentum.net, 0.5);
  assert.ok(snapshot.progress > 0, '净优势必须推动进度');
  assert.ok(snapshot.progress < 100);
});

test('争夺恰逢计分节点：控制方存在竞争者时不结算固守分', () => {
  const match = makeMatch({ scoreToWin: 1000, scoreIntervalMs: 1000 });
  const a = addAtPoint(match, 'A', 'engineer');
  match.start(0);
  let snapshot = runSteps(match, 50, 5000);
  assert.equal(snapshot.owner, 'A');
  const base = snapshot.scores.A;

  addAtPoint(match, 'B', 'vanguard');
  const before = match.recorder.events.length;
  snapshot = runSteps(match, 5050, 7000);
  const skipped = match.recorder.events.slice(before).filter((e) => e.type === 'hold_skipped');
  assert.ok(skipped.length >= 1, '争夺期间的计分节点跳过');
  assert.ok(
    skipped.some((e) => e.reason === 'contested_presence' || e.reason === 'under_contest')
  );
  assert.equal(snapshot.scores.A, base, '争夺期间控制方不得自动得分');
});

test('压制与无资格角色分别参与：存活计数与占领权重分离', () => {
  const match = makeMatch({ scoreToWin: 1000 });
  const a = addAtPoint(match, 'A');
  const support = addAtPoint(match, 'A', 'support');
  const b = addAtPoint(match, 'B');
  match.start(0);

  b.x = match.config.point.x + match.config.point.radius - 5;
  b.y = match.config.point.y;
  // B 射击 A，A 进入压制状态：仍在场计入存活争夺，但占领权重归零。
  match.command(b.id, { type: 'fire', targetPlayerId: a.id }, 100);
  const snapshot = match.step(150);
  const rowA = snapshot.factions.A.members.find((m) => m.entityId === a.id);
  assert.equal(rowA.suppressed, true);
  assert.equal(rowA.contest, 1, '被压制仍计为存活在场');
  assert.equal(rowA.capture, 0, '被压制不参与占领推进');
  const supportRow = snapshot.factions.A.members.find((m) => m.entityId === support.id);
  assert.equal(supportRow.status, 'ineligible');
  assert.equal(supportRow.capture, 0);
  assert.equal(snapshot.factions.B.capture, 1);
  assert.equal(snapshot.factions.A.contest, 2);
  assert.equal(snapshot.factions.A.capture, 0);
});

test('角色离场释放参与记录，复活后按新身份重新登记', () => {
  const match = makeMatch({
    scoreToWin: 1000,
    respawnMs: 1000,
    spawns: { A: { x: 80, y: 80 }, B: { x: 450, y: 450 }, C: { x: 450, y: 450 } }
  });
  const a = addAtPoint(match, 'A');
  const b = addAtPoint(match, 'B');
  match.start(0);
  runSteps(match, 50, 600);
  assert.equal(match.presence.size, 2);

  b.x = match.config.point.x + 10;
  b.y = match.config.point.y;
  match.command(b.id, { type: 'fire', targetPlayerId: a.id }, 700);
  // 连续射击直至 A 阵亡
  for (let i = 0; i < 5 && a.alive; i += 1) {
    match.command(b.id, { type: 'fire', targetPlayerId: a.id }, 700 + i * 250);
  }
  assert.equal(a.alive, false);
  assert.equal(match.presence.has(a.id), false, '阵亡即释放参与记录');
  const down = match.recorder.events.find((e) => e.type === 'down');
  assert.ok(down);
  assert.equal(down.presenceReleased, true);

  // 复活发生在据点外：新身份 generation 递增，不再占用旧记录。
  const afterResp = runSteps(match, 1000, 3200);
  const respawn = match.recorder.events.find((e) => e.type === 'respawn');
  assert.ok(respawn);
  assert.ok(respawn.generation > down.generation, '复活推进 generation');
  assert.equal(match.presence.has(a.id), false);
  const player = afterResp.players.find((p) => p.id === a.id);
  assert.equal(player.generation, respawn.generation);
});

test('过期身份指令在复活后被拒绝，防止对象身份复用', () => {
  const match = makeMatch({
    scoreToWin: 1000,
    respawnMs: 500,
    spawns: { A: { x: 80, y: 80 }, B: { x: 450, y: 450 }, C: { x: 450, y: 450 } }
  });
  const a = addAtPoint(match, 'A');
  const b = addAtPoint(match, 'B');
  match.start(0);
  for (let i = 0; i < 6 && a.alive; i += 1) {
    match.command(b.id, { type: 'fire', targetPlayerId: a.id }, i * 250);
  }
  assert.equal(a.alive, false);
  const staleGeneration = a.generation;
  runSteps(match, 600, 1700);
  assert.ok(a.generation > staleGeneration);

  assert.throws(
    () =>
      match.command(
        a.id,
        { type: 'move', generation: staleGeneration, target: { x: 500, y: 500 } },
        match.clockMs
      ),
    /对象身份已更新/
  );
  assert.doesNotThrow(() =>
    match.command(a.id, { type: 'move', generation: a.generation, target: { x: 500, y: 500 } }, match.clockMs)
  );
});

test('阵营切换后重新解释资格，而不是把人数相减', () => {
  const match = makeMatch({ scoreToWin: 1000 });
  const a = addAtPoint(match, 'A', 'engineer');
  const b = addAtPoint(match, 'B', 'engineer', 'defector');
  match.start(0);
  runSteps(match, 50, 1500);

  // B 方成员叛变到 A：旧记录释放，下一 tick 以 A 阵营身份重新参与。
  match.setFaction(b.id, 'A', 1550);
  const snapshot = match.step(1600);
  assert.equal(match.presence.size, 2);
  const presence = snapshot.presence.find((p) => p.playerId === b.id);
  assert.equal(presence.faction, 'A', '参与记录重建为新阵营');
  assert.equal(snapshot.momentum.kind, 'solo');
  assert.equal(snapshot.momentum.direction, 'A');
  // 权重 1.5 + 1.5 = 3，而不是把 A 的 1.5 与 B 的 1.5 相减得到 0。
  assert.equal(snapshot.momentum.magnitude, 3);
});

test('胜利条件达成后不接受旧计分回调', () => {
  const match = makeMatch({ scoreToWin: 10, captureBonus: 10, holdPointsPerSec: 3 });
  const a = addAtPoint(match, 'A');
  match.start(0);
  match.progress = 100;
  match.challenger = 'A';
  match.resolveCapture('A', 100);
  assert.equal(match.phase, 'ended');
  assert.equal(match.endReason, 'score');

  // 旧回调（例如延迟到达的固守结算）不得在结束后加分。
  const event = match.awardScore('A', 5, 'hold', 200, { delayed: true });
  assert.equal(event, null);
  assert.equal(match.scores.A, 10);

  // 时间推进不会让已结束对局再计分。
  match.step(1500);
  assert.equal(match.scores.A, 10);
  assert.equal(match.phase, 'ended');
});

test('分数按比赛时间结算：暂停推进后按节点补算而不重复', () => {
  const match = makeMatch({ scoreToWin: 1000, scoreIntervalMs: 1000, holdPointsPerSec: 3 });
  const a = addAtPoint(match, 'A');
  match.start(0);
  match.progress = 100;
  match.challenger = 'A';
  match.resolveCapture('A', 100);

  // 一次性跨过 3 个节点：应按边界时间依次补算 3 次，而不是只算一次。
  match.step(3500);
  const scoreEvents = match.recorder.events.filter((e) => e.type === 'score' && e.reason === 'hold');
  assert.equal(scoreEvents.length, 3);
  const buckets = scoreEvents.map((e) => e.bucket).sort();
  assert.deepEqual(buckets, [1, 2, 3]);
  // 再推进不得重算已经结算过的节点。
  match.step(3700);
  const after = match.recorder.events.filter((e) => e.type === 'score' && e.reason === 'hold');
  assert.equal(after.length, 3);
});

test('结算时间序列：每一步推进的时间不超过比赛预算，超时判负', () => {
  const match = makeMatch({ scoreToWin: 1000, durationMs: 2000 });
  addAtPoint(match, 'A');
  match.start(0);
  match.step(2500);
  assert.equal(match.phase, 'ended');
  assert.equal(match.endReason, 'timeout');
  assert.equal(match.endedAtElapsedMs, 2000);
  // 超时后的节点不再结算分数。
  const scoresAfter = match.scores.A;
  match.step(5000);
  assert.equal(match.scores.A, scoresAfter);
});

test('回放数据包含关键帧与事件，可在时间轴上定位', () => {
  const match = makeMatch({ scoreToWin: 1000, keyframeIntervalMs: 500 });
  addAtPoint(match, 'A');
  match.start(0);
  runSteps(match, 50, 6000);
  const replay = match.replayData();
  assert.ok(replay.frames.length >= 4);
  assert.ok(replay.events.some((e) => e.type === 'captured'));
  const frameTimes = replay.frames.map((f) => f.atMs);
  for (let i = 1; i < frameTimes.length; i += 1) {
    assert.ok(frameTimes[i] >= frameTimes[i - 1], '关键帧时间单调递增');
  }
  const eventTimes = replay.events.map((e) => e.atMs);
  for (let i = 1; i < eventTimes.length; i += 1) {
    assert.ok(eventTimes[i] >= eventTimes[i - 1], '事件时间单调递增');
  }
});

test('对象身份复用：generation 变化的参与记录作废旧身份并按新资格登记', () => {
  const match = makeMatch({ scoreToWin: 1000 });
  const a = addAtPoint(match, 'A', 'engineer');
  match.start(0);
  match.step(100);
  assert.equal(match.presence.has(a.id), true);
  const beforeFaction = match.presence.list()[0].faction;
  assert.equal(beforeFaction, 'A');

  // 模拟对象身份复用：同一 id 的 generation 与角色被重写，旧参与记录不能沿用。
  a.generation += 1;
  a.role = 'support';
  match.step(150);
  const record = match.presence.list().find((row) => row.entityId === a.id);
  assert.ok(record, '新身份重新登记');
  assert.equal(record.generation, a.generation);
  assert.equal(record.role, 'support');
  const snapshot = match.snapshot();
  const row = snapshot.factions.A.members.find((m) => m.entityId === a.id);
  assert.equal(row.status, 'ineligible', '按新角色重新判定资格');
  const exitted = match.recorder.events.filter((e) => e.type === 'presence_exit');
  assert.ok(exitted.length >= 1, '旧身份产生离场事件');
});

test('多方争夺净值按复杂度折扣推进，且领跑者优势缩小时进度不再累积', () => {
  const match = makeMatch({ scoreToWin: 1000 });
  const a = addAtPoint(match, 'A', 'engineer');
  const b = addAtPoint(match, 'B', 'vanguard');
  match.start(0);
  match.step(1000);
  const first = match.snapshot();
  // 净值 0.5，折扣 0.5 -> 0.25 * captureRate 20 = 5/s
  assert.equal(first.challenger, 'A');
  assert.ok(first.progress > 0 && first.progress < 100);

  // B 提升为工兵：权重 1.5 对 1.5 -> 净值为 0，进入僵持，进度回落而非继续推进。
  match.command(b.id, { type: 'stop' }, 1000);
  b.role = 'engineer';
  match.step(1500);
  const locked = match.snapshot();
  assert.equal(locked.momentum.kind, 'deadlock');
  assert.ok(locked.progress <= first.progress, '净值消失时不得继续累积');
  assert.ok(a.role === 'engineer');
});

test('无占领资格的存活敌人也会打断控制方固守计分', () => {
  const match = makeMatch({ scoreToWin: 1000, scoreIntervalMs: 1000 });
  const a = addAtPoint(match, 'A', 'engineer');
  match.start(0);
  runSteps(match, 50, 6000);
  assert.equal(match.owner, 'A');
  const before = match.snapshot().scores.A;
  assert.ok(before > 0);

  // 敌方支援角色入场：不推进占领（权重 0），但作为存活敌人阻止固守结算。
  addAtPoint(match, 'B', 'support');
  const from = match.recorder.events.length;
  runSteps(match, 6050, 8500);
  const skipped = match.recorder.events
    .slice(from)
    .filter((e) => e.type === 'hold_skipped' && e.reason === 'contested_presence');
  assert.ok(skipped.length >= 1, '无资格敌人也应打断固守');
  assert.equal(match.snapshot().scores.A, before, '打断期间控制方不得计分');
});

test('单方挑战推满进度后易主，并给新控制方占领奖励', () => {
  const match = makeMatch({ scoreToWin: 1000, captureBonus: 25 });
  const a = addAtPoint(match, 'A');
  match.start(0);
  runSteps(match, 50, 6000);
  assert.equal(match.owner, 'A');

  // 控制方离开，敌方工兵单人进入：从中性进度重新挑战。
  a.x = 80;
  a.y = 80;
  runSteps(match, 6050, 6500);
  addAtPoint(match, 'B', 'engineer', 'challenger');
  runSteps(match, 6550, 13000);
  const snapshot = match.snapshot();
  assert.equal(snapshot.owner, 'B');

  const captureEvents = match.recorder.events.filter((e) => e.type === 'captured');
  assert.equal(captureEvents.length, 2, '原生占领 + 易主各一次');
  assert.equal(captureEvents.at(-1).faction, 'B');
  assert.equal(captureEvents.at(-1).fromFaction, 'A');
  const bonus = match.recorder.events.filter(
    (e) => e.type === 'score' && e.reason === 'capture' && e.faction === 'B'
  );
  assert.equal(bonus.length, 1, '易主奖励只结算一次');
  assert.equal(bonus[0].amount, 25);
});

test('独立对局互不干扰', () => {
  const one = makeMatch({ scoreToWin: 1000 });
  const two = makeMatch({ scoreToWin: 1000 });
  addAtPoint(one, 'A');
  addAtPoint(two, 'B');
  one.start(0);
  two.start(0);
  runSteps(one, 50, 6000);
  runSteps(two, 50, 6000);
  assert.equal(one.owner, 'A');
  assert.equal(two.owner, 'B');
  assert.ok(one.scores.A > 0);
  assert.equal(one.scores.B, 0);
  assert.ok(two.scores.B > 0);
  assert.equal(two.scores.A, 0);
});

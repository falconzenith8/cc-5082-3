import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/engine/match.js';
import { MatchManager } from '../src/server/manager.js';
import { EventRecorder } from '../src/engine/events.js';
import { MatchError } from '../src/engine/config.js';

const FAST_CONFIG = {
  scoreToWin: 90,
  durationMs: 60000,
  captureBonus: 20,
  holdPointsPerSec: 4,
  eventLimit: 50,
  frameLimit: 40
};

function lobbyMatch(id = 'late', config = {}) {
  const match = new Match(id, { config: { ...FAST_CONFIG, ...config }, nowMs: 0 });
  match.addPlayer({ faction: 'A', role: 'engineer', name: 'a1' }, 0);
  return match;
}

test('已结束对局拒绝迟到的加入、移动与换阵营请求', () => {
  const match = lobbyMatch();
  match.start(0);
  // 把 A 方队员移入据点并推进到终局。
  match.command('p1', { type: 'move', target: { x: 450, y: 450 } }, 0);
  let now = 0;
  while (match.phase === 'running' && now < 60000) {
    now += 250;
    match.step(now);
  }
  assert.equal(match.phase, 'ended');
  const revision = match.revision;

  assert.throws(
    () => match.addPlayer({ faction: 'B', role: 'vanguard', name: 'late' }, now),
    (error) => error instanceof MatchError && error.code === 'match_ended'
  );
  assert.throws(
    () => match.command('p1', { type: 'move', target: { x: 1, y: 1 } }, now),
    (error) => error.code === 'match_not_running'
  );
  assert.throws(
    () => match.setFaction('p1', 'B', now),
    (error) => error.code === 'match_ended'
  );
  assert.equal(match.revision, revision, '迟到事件不改变修订号');
});

test('事件与关键帧超过容量后丢弃最旧数据并累计丢弃计数', () => {
  const recorder = new EventRecorder(3, 2);
  recorder.push('a', 0);
  recorder.push('b', 1);
  recorder.push('c', 2);
  const fourth = recorder.push('d', 3);
  assert.equal(recorder.events.length, 3);
  assert.equal(recorder.events[0].type, 'b');
  assert.equal(fourth.seq, 4);
  assert.equal(recorder.droppedEvents, 1);

  recorder.frame({ owner: null }, 0);
  recorder.frame({ owner: 'A' }, 1);
  recorder.frame({ owner: 'B' }, 2);
  assert.equal(recorder.frames.length, 2);
  assert.equal(recorder.droppedFrames, 1);

  const stats = recorder.stats();
  assert.equal(stats.eventLimit, 3);
  assert.equal(stats.frameLimit, 2);
  assert.equal(stats.lastSeq, 4);
});

test('房间管理器执行数量上限并按固定次序关闭房间', () => {
  const manager = new MatchManager({ now: () => 0, maxRooms: 2 });
  manager.create({ name: 'r1' });
  manager.create({ name: 'r2' });
  assert.throws(() => manager.create({ name: 'r3' }), (error) => error.code === 'room_limit');

  const first = manager.closeRoom('m1', 'test_close');
  assert.equal(first.matchId, 'm1');
  assert.ok(first.recorder && typeof first.recorder.events === 'number');
  assert.equal(manager.matches.has('m1'), false);
  assert.equal(manager.closedRooms.length, 1);
  assert.throws(() => manager.get('m1'), (error) => error.code === 'unknown_match');

  // 关闭通知会先于注销订阅推送给监听者。
  const events = [];
  const match = manager.get('m2');
  manager.subscribe('m2', (payload) => events.push(payload));
  manager.closeRoom('m2', 'test_close');
  assert.equal(events[0].closed, true);
  assert.equal(events[0].reason, 'test_close');
});

test('关停报告证明时钟停止、房间与订阅全部清空', () => {
  const manager = new MatchManager({ now: () => 0, maxRooms: 3 });
  manager.create({ name: 'r1' });
  manager.create({ name: 'r2' });
  manager.startClock(50);
  manager.subscribe('m1', () => {});

  const report = manager.shutdown('unit_shutdown');
  assert.equal(report.stoppedClock, true);
  assert.equal(report.rooms.length, 2);
  assert.equal(report.remainingRooms, 0);
  assert.equal(report.remainingSubscriptions, 0);
  assert.equal(manager.tickTimer, null);
});

test('统计接口暴露房间相位、缓冲容量与丢弃计数', () => {
  const manager = new MatchManager({ now: () => 0, maxRooms: 3 });
  const match = manager.create({ name: 'r1', config: { eventLimit: 10, frameLimit: 5 } });
  match.addPlayer({ faction: 'A', role: 'vanguard' }, 0);
  match.start(0);
  match.step(100);
  const stats = manager.stats();
  assert.equal(stats.rooms, 1);
  assert.equal(stats.maxRooms, 3);
  assert.equal(stats.phases.running, 1);
  assert.ok(stats.bufferedEvents > 0);
  assert.ok(stats.bufferedFrames > 0);
});

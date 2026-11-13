import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  api,
  assertBackgroundTasksEnded,
  dumpDiagnostics,
  getFreePort,
  spawnInstance,
  stopInstance,
  wait,
  waitForReady
} from './runtime-harness.js';
import { BotClient, waitForPhase } from '../lib/bot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUN_DIR = path.join(ROOT, 'run', `selftest-${Date.now()}`);
fs.mkdirSync(RUN_DIR, { recursive: true });

const SELFTEST_ROOM = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'deploy/resources/room-selftest.json'), 'utf8')
);

const results = [];
const instances = [];

function record(name, passed, detail = {}) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : ` :: ${detail.error || ''}`}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
    return detail;
  } catch (error) {
    record(name, false, { error: error.stack || error.message });
    throw error;
  }
}

async function createRoom(base, body) {
  const response = await api(base, '/api/matches', { method: 'POST', body });
  assert.equal(response.status, 201, `创建房间失败：${JSON.stringify(response.json)}`);
  return response.json.match;
}

function botLineup(factions) {
  // 双阵营真实争夺：工兵+突击手组合，两边都能进入据点并互相射击。
  const lineup = [];
  for (const faction of factions) {
    lineup.push({ faction, role: 'engineer' });
    lineup.push({ faction, role: 'vanguard' });
    lineup.push({ faction, role: 'vanguard' });
  }
  return lineup;
}

async function runContestedMatch(base, label, seedBase) {
  const room = await createRoom(base, SELFTEST_ROOM);
  const bots = [];
  const lineup = botLineup(['A', 'B']);
  for (let i = 0; i < lineup.length; i += 1) {
    const slot = lineup[i];
    const bot = new BotClient(base, {
      name: `${label}-${slot.faction}${i}`,
      seed: seedBase + i * 97
    });
    await bot.join(room.id, slot.faction, slot.role);
    bots.push(bot);
  }
  const started = await api(base, `/api/matches/${room.id}/start`, { method: 'POST' });
  assert.equal(started.status, 200);
  for (const bot of bots) bot.start();

  const finalSnapshot = await waitForPhase(base, room.id, 'ended', { timeoutMs: 90000 });
  for (const bot of bots) await bot.stop();

  const events = await api(base, `/api/matches/${room.id}/events?since=0`);
  const types = new Set(events.json.events.map((e) => e.type));
  assert.ok(types.has('captured'), '必须产生占领事件');
  assert.ok(types.has('score'), '必须产生计分事件');
  assert.ok(types.has('match_end'), '必须产生终局事件');
  const scoreEvents = events.json.events.filter((e) => e.type === 'score');
  const totals = { A: 0, B: 0, C: 0 };
  for (const event of scoreEvents) totals[event.faction] += event.amount;
  assert.equal(totals.A, finalSnapshot.scores.A, 'A 阵营计分事件总和与快照一致');
  assert.equal(totals.B, finalSnapshot.scores.B, 'B 阵营计分事件总和与快照一致');
  assert.ok(totals.A > 0 && totals.B > 0, '双方都应真实参与争夺并得分');
  assert.equal(finalSnapshot.phase, 'ended');
  const winner = events.json.events.find((e) => e.type === 'match_end').winner;
  assert.ok(winner === 'A' || winner === 'B' || winner === null, '胜者字段合法');
  if (finalSnapshot.endReason === 'score') {
    assert.ok(winner, '达到胜利分结束时必须有胜者');
    assert.equal(finalSnapshot.scores[winner] >= SELFTEST_ROOM.config.scoreToWin, true);
  }
  return { room, finalSnapshot, events: events.json.events, bots };
}

async function main() {
  console.log(`自检运行目录：${RUN_DIR}\n`);
  const [portA, portB, portC] = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);

  const alpha = spawnInstance({
    instanceId: 'alpha',
    port: portA,
    stateDir: path.join(RUN_DIR, 'alpha'),
    maxRooms: 8,
    logMaxBytes: 4096
  });
  const beta = spawnInstance({
    instanceId: 'beta',
    port: portB,
    stateDir: path.join(RUN_DIR, 'beta'),
    maxRooms: 8
  });
  instances.push(alpha, beta);

  try {
    await Promise.all([waitForReady(alpha), waitForReady(beta)]);
    const baseA = `http://127.0.0.1:${portA}`;
    const baseB = `http://127.0.0.1:${portB}`;

    await check('两个实例独立启动且健康检查通过', async () => {
      const ha = await api(baseA, '/api/health');
      const hb = await api(baseB, '/api/health');
      assert.equal(ha.status, 200);
      assert.equal(hb.status, 200);
      assert.notEqual(ha.json.instanceId, hb.json.instanceId);
      assert.equal(ha.json.rooms, 0);
      assert.equal(ha.json.maxRooms, 8);
      return { alpha: ha.json, beta: hb.json };
    });

    // 场景 1：双实例上各跑一场真实争夺对局，验证胜负与计分。
    const matchAResult = await check('alpha 实例：模拟角色真实争夺并结算胜负计分', () =>
      runContestedMatch(baseA, 'alpha', 1001)
    );
    const matchBResult = await check('beta 实例：模拟角色真实争夺并结算胜负计分', () =>
      runContestedMatch(baseB, 'beta', 2002)
    );

    // 场景 2：每个实例再开一间房，关闭已结束房间不得影响另一房间的区域状态。
    await check('关闭一个房间不会清空另一房间的据点区域状态', async () => {
      const roomA2 = await createRoom(baseA, SELFTEST_ROOM);
      const roomB2 = await createRoom(baseB, SELFTEST_ROOM);
      const bot = new BotClient(baseA, { name: 'iso-A', seed: 4242 });
      await bot.join(roomA2.id, 'A', 'engineer');
      const botB = new BotClient(baseB, { name: 'iso-B', seed: 4343 });
      await botB.join(roomB2.id, 'B', 'vanguard');
      await api(baseA, `/api/matches/${roomA2.id}/start`, { method: 'POST' });
      await api(baseB, `/api/matches/${roomB2.id}/start`, { method: 'POST' });
      await bot.command({ type: 'move', target: { x: 450, y: 450 } });
      await botB.command({ type: 'move', target: { x: 450, y: 450 } });
      await wait(3000);
      await bot.stop();
      await botB.stop();

      const beforeA = (await api(baseA, `/api/matches/${roomA2.id}`)).json.match;
      const beforeB = (await api(baseB, `/api/matches/${roomB2.id}`)).json.match;
      assert.ok(beforeA.presence.length > 0 || beforeA.owner === 'A', 'alpha 新房已有区域状态');
      assert.ok(beforeB.presence.length > 0 || beforeB.owner === 'B', 'beta 新房已有区域状态');
      const eventsBeforeA = (await api(baseA, `/api/matches/${roomA2.id}/events?since=0`)).json.events;
      const lastSeqA = eventsBeforeA.at(-1)?.seq ?? 0;

      // 删除 alpha 上第一场已结束对局。运行中的房间会随自身 tick 演进，
      // 因此隔离性看的是：控制权/计分/队员不被重置，事件序列连续，进度只按内核规则连续变化。
      const del = await api(baseA, `/api/matches/${matchAResult.room.id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.equal(del.json.closed.matchId, matchAResult.room.id);
      assert.ok(del.json.closed.recorder.events >= 0);

      const afterA = (await api(baseA, `/api/matches/${roomA2.id}`)).json.match;
      const afterB = (await api(baseB, `/api/matches/${roomB2.id}`)).json.match;
      assert.equal(afterA.owner, beforeA.owner, '同实例另一房间控制权不变');
      assert.deepEqual(afterA.scores, beforeA.scores, '同实例另一房间计分不被删除操作改动');
      assert.equal(afterB.owner, beforeB.owner, '另一实例房间控制权不变');
      assert.deepEqual(afterB.scores, beforeB.scores, '另一实例房间计分不变');
      assert.ok(afterA.players.length === beforeA.players.length, '另一房间队员不被牵连清理');
      assert.ok(afterB.players.length === beforeB.players.length, '跨实例队员不被牵连清理');
      const continuousProgress = Math.abs(afterA.progress - beforeA.progress) <= 10;
      assert.ok(
        continuousProgress,
        `占领进度应连续演进，删除前 ${beforeA.progress}，删除后 ${afterA.progress}`
      );
      const eventsAfterA = (await api(baseA, `/api/matches/${roomA2.id}/events?since=0`)).json.events;
      const gap = eventsAfterA.filter((e) => e.seq <= lastSeqA).length;
      assert.equal(gap, eventsBeforeA.length, '另一房间事件流未被删除操作截断');

      const missing = await api(baseA, `/api/matches/${matchAResult.room.id}`);
      assert.equal(missing.status, 404);
      return { roomA2: roomA2.id, roomB2: roomB2.id };
    });

    // 场景 3：房间中途退出——运行中的房间被关闭，清理次序正确且其余房间存活。
    await check('房间中途退出：关闭运行中的房间并保留终态摘要', async () => {
      const room = await createRoom(baseA, SELFTEST_ROOM);
      const bot = new BotClient(baseA, { name: 'exit-mid', seed: 5555 });
      await bot.join(room.id, 'A', 'vanguard');
      await api(baseA, `/api/matches/${room.id}/start`, { method: 'POST' });
      bot.start();
      await wait(1500);
      const del = await api(baseA, `/api/matches/${room.id}`, { method: 'DELETE' });
      await bot.stop();
      assert.equal(del.status, 200);
      assert.equal(del.json.closed.phase, 'running', '摘要记录的是退出时的运行态');
      assert.equal(del.json.closed.presenceAtClose >= 0, true);
      const gone = await api(baseA, `/api/matches/${room.id}`);
      assert.equal(gone.status, 404);
      const health = await api(baseA, '/api/health');
      assert.equal(health.json.ok, true, '房间退出后实例仍然健康');
      return { closed: del.json.closed };
    });

    // 场景 4：已结束对局收到迟到事件——加入、移动、换阵营全部被内核拒绝。
    await check('已结束对局拒绝迟到事件且状态不被修改', async () => {
      const endedId = matchBResult.room.id;
      const before = (await api(baseB, `/api/matches/${endedId}`)).json.match;
      const lateJoin = await api(baseB, `/api/matches/${endedId}/players`, {
        method: 'POST',
        body: { faction: 'C', role: 'vanguard', name: '迟到者' }
      });
      assert.equal(lateJoin.status, 409);
      assert.equal(lateJoin.json.code, 'match_ended');
      const lateMove = await api(baseB, `/api/matches/${endedId}/players/p1/command`, {
        method: 'POST',
        body: { type: 'move', target: { x: 1, y: 1 }, generation: 1 }
      });
      assert.equal(lateMove.status, 409);
      assert.equal(lateMove.json.code, 'match_not_running');
      const lateSwitch = await api(baseB, `/api/matches/${endedId}/players/p1/faction`, {
        method: 'POST',
        body: { faction: 'C' }
      });
      assert.equal(lateSwitch.status, 409);
      const after = (await api(baseB, `/api/matches/${endedId}`)).json.match;
      assert.equal(after.revision, before.revision, '迟到事件不得推进修订号');
      assert.deepEqual(after.scores, before.scores);
      return { codes: [lateJoin.json.code, lateMove.json.code] };
    });

    // 场景 5：端口冲突——第三个实例绑定 alpha 端口必须失败，且 alpha 不受影响。
    await check('模拟端口冲突：重复绑定被拒绝且原实例不受影响', async () => {
      const conflicting = spawnInstance({
        instanceId: 'conflict',
        port: portA,
        stateDir: path.join(RUN_DIR, 'conflict')
      });
      const code = await new Promise((resolve) => {
        conflicting.child.on('exit', resolve);
      });
      assert.notEqual(code, 0, '冲突实例必须非零退出');
      const output = conflicting.stderr() + conflicting.stdout();
      assert.match(output, /PORT_CONFLICT|EADDRINUSE/, '输出端口冲突诊断');
      const health = await api(baseA, '/api/health');
      assert.equal(health.json.ok, true, '原 alpha 实例仍然健康');
      return { exitCode: code };
    });

    // 场景 6：房间数量上限。
    await check('实例数量与房间数量上限生效', async () => {
      const small = spawnInstance({
        instanceId: 'capped',
        port: portC,
        stateDir: path.join(RUN_DIR, 'capped'),
        maxRooms: 1
      });
      instances.push(small);
      await waitForReady(small);
      const baseC = `http://127.0.0.1:${portC}`;
      await createRoom(baseC, SELFTEST_ROOM);
      const second = await api(baseC, '/api/matches', { method: 'POST', body: SELFTEST_ROOM });
      assert.equal(second.status, 409);
      assert.equal(second.json.code, 'room_limit');
      return { maxRooms: 1 };
    });

    // 场景 7：日志容量限制——小容量日志文件必须发生轮转且不无限增长。
    await check('日志容量限制触发轮转并保留有限份数', async () => {
      const noisy = await createRoom(baseA, SELFTEST_ROOM);
      for (let i = 0; i < 60; i += 1) {
        await api(baseA, '/api/health');
        await wait(30);
      }
      const files = fs.readdirSync(alpha.stateDir);
      const rotated = files.filter((f) => f.startsWith('alpha.log'));
      assert.ok(rotated.length >= 2, `期望出现轮转日志，实际：${rotated.join(', ')}`);
      for (const file of rotated) {
        const size = fs.statSync(path.join(alpha.stateDir, file)).size;
        // 按整行轮转不截断半行 JSON，允许超出上限一个日志行（单行远小于 1 KiB）。
        assert.ok(size <= 4096 + 1024, `${file} 超出容量上限：${size}`);
      }
      await api(baseA, `/api/matches/${noisy.id}`, { method: 'DELETE' });
      return { files: rotated };
    });

    // 场景 8：事件/关键帧容量在统计接口可见。
    await check('事件与关键帧容量有界且通过统计接口暴露', async () => {
      const stats = await api(baseA, '/api/stats');
      assert.equal(stats.status, 200);
      assert.ok(stats.json.bufferedEvents >= 0);
      assert.ok(stats.json.maxRooms === 8);
      const replayRoom = await createRoom(baseA, SELFTEST_ROOM);
      const detail = (await api(baseA, `/api/matches/${replayRoom.id}/events?since=0`)).json;
      assert.ok(detail.capacity.eventLimit === SELFTEST_ROOM.config.eventLimit);
      assert.ok(detail.capacity.frameLimit === SELFTEST_ROOM.config.frameLimit);
      await api(baseA, `/api/matches/${replayRoom.id}`, { method: 'DELETE' });
      return stats.json;
    });
  } catch (error) {
    const diagDir = dumpDiagnostics(RUN_DIR, instances, {
      error: error.stack || error.message,
      results
    });
    console.error(`\n自检失败，诊断资料已保留：${diagDir}`);
    for (const instance of instances) {
      if (instance.child.exitCode === null) {
        instance.child.kill('SIGKILL');
      }
    }
    process.exitCode = 1;
    printSummary();
    return;
  }

  // 有序关停两个实例，并验证后台任务确实结束。
  try {
    await check('关停实例后清理报告证明房间、订阅与时钟全部结束', async () => {
      const codeA = await stopInstance(alpha);
      const codeB = await stopInstance(beta);
      assert.equal(codeA, 0);
      assert.equal(codeB, 0);
      const reportA = assertBackgroundTasksEnded(alpha);
      const reportB = assertBackgroundTasksEnded(beta);
      assert.ok(reportA.rooms.length + reportB.rooms.length >= 2, '关停时逐间清理了房间');
      return {
        alpha: { rooms: reportA.rooms.length, remainingRooms: reportA.remainingRooms },
        beta: { rooms: reportB.rooms.length, remainingRooms: reportB.remainingRooms }
      };
    });

    const capped = instances.find((i) => i.instanceId === 'capped');
    if (capped && capped.child.exitCode === null) {
      await stopInstance(capped);
      assertBackgroundTasksEnded(capped);
    }
  } catch (error) {
    const diagDir = dumpDiagnostics(RUN_DIR, instances, {
      stage: 'shutdown',
      error: error.stack || error.message,
      results
    });
    console.error(`\n关停验证失败，诊断资料已保留：${diagDir}`);
    process.exitCode = 1;
  }

  printSummary();
}

function printSummary() {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const summaryPath = path.join(RUN_DIR, 'selftest-result.json');
  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ at: new Date().toISOString(), passed, failed, runDir: RUN_DIR, results }, null, 2)
  );
  console.log(`\n结果：${passed} 通过 / ${failed} 失败；摘要 ${summaryPath}`);
}

main();

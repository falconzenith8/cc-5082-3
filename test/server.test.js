import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/index.js';

let server;
let base;

before(async () => {
  let nowMs = 0;
  server = createServer({ now: () => nowMs, tickMs: 0, maxRooms: 32 });
  server.manager.stopClock();
  server.clock = { advance: (ms) => (nowMs += ms), now: () => nowMs };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.manager.stopClock();
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { status: response.status, json };
}

async function createMatch(name = '测试对局') {
  const response = await call('/api/matches', { method: 'POST', body: { name } });
  assert.equal(response.status, 201);
  return response.json.match.id;
}

async function addPlayer(matchId, faction, role = 'vanguard') {
  const response = await call(`/api/matches/${matchId}/players`, {
    method: 'POST',
    body: { faction, role, name: `${faction}-${role}` }
  });
  assert.equal(response.status, 201);
  return response.json.player;
}

test('多场对局并行维护，互不影响', async () => {
  const one = await createMatch('一号场');
  const two = await createMatch('二号场');
  await addPlayer(one, 'A');
  await addPlayer(two, 'B');

  const list = await call('/api/matches');
  assert.equal(list.status, 200);
  assert.ok(list.json.matches.length >= 2);
  assert.notEqual(one, two);

  const a = await call(`/api/matches/${one}`);
  assert.equal(a.json.match.name, '一号场');
  assert.equal(a.json.match.players[0].faction, 'A');
  const b = await call(`/api/matches/${two}`);
  assert.equal(b.json.match.players[0].faction, 'B');
});

test('输入驱动占领：移动指令推进占领条，而不是定时动画', async () => {
  const matchId = await createMatch('输入驱动');
  const player = await addPlayer(matchId, 'A');
  await call(`/api/matches/${matchId}/start`, { method: 'POST' });

  const before = await call(`/api/matches/${matchId}`);
  const beforeProgress = before.json.match.progress;

  await call(`/api/matches/${matchId}/players/${player.id}/command`, {
    method: 'POST',
    body: { type: 'move', target: { x: 450, y: 450 } }
  });

  // 使用固定时间源按 500ms 步进推进，足够从出生点走到据点并完成占领。
  for (let i = 0; i < 20; i += 1) {
    server.clock.advance(500);
    server.manager.tick(server.clock.now());
  }
  const after = await call(`/api/matches/${matchId}`);
  assert.equal(after.json.match.owner, 'A');
  assert.ok(after.json.match.progress >= beforeProgress);
  const captured = after.json.match;
  assert.equal(captured.phase, 'running');
});

test('SSE 推送资格、控制权与计分事件', async () => {
  const matchId = await createMatch('事件流');
  const player = await addPlayer(matchId, 'A');
  await call(`/api/matches/${matchId}/start`, { method: 'POST' });

  const controller = new AbortController();
  const events = [];
  const response = await fetch(`${base}/api/matches/${matchId}/stream`, {
    signal: controller.signal
  });
  assert.equal(response.status, 200);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consumed = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (buffer.includes('\n\n')) {
          const index = buffer.indexOf('\n\n');
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const lines = chunk.split('\n');
          const type = lines.find((line) => line.startsWith('event: '))?.slice(7);
          const data = lines.find((line) => line.startsWith('data: '));
          if (data) events.push({ type, data: JSON.parse(data.slice(6)) });
        }
      }
    } catch {
      // aborted
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));

  await call(`/api/matches/${matchId}/players/${player.id}/command`, {
    method: 'POST',
    body: { type: 'move', target: { x: 450, y: 450 } }
  });
  for (let i = 0; i < 24; i += 1) {
    server.clock.advance(500);
    server.manager.tick(server.clock.now());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  controller.abort();
  await consumed;

  assert.ok(events.some((e) => e.type === 'hello'), '收到初始快照');
  assert.ok(events.some((e) => e.type === 'presence_enter'), '收到入场资格事件');
  assert.ok(events.some((e) => e.type === 'captured'), '收到控制权变更事件');
  assert.ok(events.some((e) => e.type === 'score'), '收到计分事件');
  const stateEvent = events.filter((e) => e.type === 'state').at(-1);
  assert.ok(stateEvent.data.snapshot.scores.A > 0);
});

test('事件回放包含关键帧、事件与地图数据', async () => {
  const matchId = await createMatch('回放');
  const player = await addPlayer(matchId, 'A');
  await call(`/api/matches/${matchId}/start`, { method: 'POST' });
  await call(`/api/matches/${matchId}/players/${player.id}/command`, {
    method: 'POST',
    body: { type: 'move', target: { x: 450, y: 450 } }
  });
  for (let i = 0; i < 20; i += 1) {
    server.clock.advance(500);
    server.manager.tick(server.clock.now());
  }

  const replay = await call(`/api/matches/${matchId}/replay`);
  assert.equal(replay.status, 200);
  assert.ok(replay.json.frames.length > 0);
  assert.ok(replay.json.events.length > 0);
  assert.ok(replay.json.map.width > 0);
  assert.ok(replay.json.point.radius > 0);
  assert.ok(replay.json.events.some((e) => e.type === 'captured'));

  const since = await call(`/api/matches/${matchId}/events?since=0`);
  const later = await call(`/api/matches/${matchId}/events?since=${since.json.events.length}`);
  assert.ok(Array.isArray(since.json.events));
  assert.ok(later.json.events.length <= since.json.events.length);
});

test('错误输入被服务端拒绝且不改变状态', async () => {
  const matchId = await createMatch('错误输入');
  const bad = await call(`/api/matches/${matchId}/players`, {
    method: 'POST',
    body: { faction: 'Z' }
  });
  assert.equal(bad.status, 400);

  const player = await addPlayer(matchId, 'A');
  await call(`/api/matches/${matchId}/start`, { method: 'POST' });
  const before = await call(`/api/matches/${matchId}`);
  const command = await call(`/api/matches/${matchId}/players/${player.id}/command`, {
    method: 'POST',
    body: { type: 'move', target: { x: 'not-a-number', y: 0 } }
  });
  assert.equal(command.status, 400);
  const after = await call(`/api/matches/${matchId}`);
  assert.deepEqual(after.json.match.players, before.json.match.players);

  const unknown = await call('/api/matches/m999');
  assert.equal(unknown.status, 404);
});

test('多场对局并行推进，各自独立结算与回放', async () => {
  const alpha = await createMatch('并行甲');
  const beta = await createMatch('并行乙');
  const pa = await addPlayer(alpha, 'A', 'engineer');
  const pb = await addPlayer(beta, 'B', 'engineer');
  await call(`/api/matches/${alpha}/start`, { method: 'POST' });
  await call(`/api/matches/${beta}/start`, { method: 'POST' });
  await call(`/api/matches/${alpha}/players/${pa.id}/command`, {
    method: 'POST',
    body: { type: 'move', target: { x: 450, y: 450 } }
  });
  await call(`/api/matches/${beta}/players/${pb.id}/command`, {
    method: 'POST',
    body: { type: 'move', target: { x: 450, y: 450 } }
  });
  for (let i = 0; i < 20; i += 1) {
    server.clock.advance(500);
    server.manager.tick(server.clock.now());
  }
  const one = await call(`/api/matches/${alpha}`);
  const two = await call(`/api/matches/${beta}`);
  assert.equal(one.json.match.owner, 'A');
  assert.equal(two.json.match.owner, 'B');
  assert.ok(one.json.match.scores.A > 0);
  assert.equal(one.json.match.scores.B, 0, '甲场的分数不流到乙场');
  assert.ok(two.json.match.scores.B > 0);
  assert.equal(two.json.match.scores.A, 0);

  const replayA = await call(`/api/matches/${alpha}/replay`);
  const replayB = await call(`/api/matches/${beta}/replay`);
  assert.equal(replayA.json.id, alpha);
  assert.equal(replayB.json.id, beta);
  const capturedA = replayA.json.events.filter((e) => e.type === 'captured');
  const capturedB = replayB.json.events.filter((e) => e.type === 'captured');
  assert.ok(capturedA.some((e) => e.faction === 'A'));
  assert.ok(capturedB.some((e) => e.faction === 'B'));
});

test('玩家加入、阵容切换与移除都反映在快照中', async () => {
  const matchId = await createMatch('生命周期');
  const player = await addPlayer(matchId, 'A', 'engineer');
  assert.equal(player.role, 'engineer');
  assert.equal(player.captureWeight, 1.5);

  const switched = await call(`/api/matches/${matchId}/players/${player.id}/faction`, {
    method: 'POST',
    body: { faction: 'C' }
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.json.player.faction, 'C');
  assert.equal(switched.json.player.slot.startsWith('C'), true);

  const removed = await call(`/api/matches/${matchId}/players/${player.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const snapshot = await call(`/api/matches/${matchId}`);
  assert.equal(snapshot.json.match.players.length, 0);
  assert.equal(snapshot.json.match.presence.length, 0, '离场角色释放参与记录');
});

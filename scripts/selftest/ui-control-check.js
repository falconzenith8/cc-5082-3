// 模拟对局操作界面的真实操作链路：浏览器只调用这些 HTTP 接口，控件由据点内核裁决。
// 验证：移动队员 → 进入据点 → 占领进度推进 → 易主与计分事件 → 非法操作收到结构化失败反馈。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { api, getFreePort, spawnInstance, stopInstance, wait, waitForReady } from './runtime-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUN_DIR = path.join(ROOT, 'run', `ui-check-${Date.now()}`);
fs.mkdirSync(RUN_DIR, { recursive: true });

const roomBody = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/resources/room-selftest.json'), 'utf8'));

async function main() {
  const port = await getFreePort();
  const instance = spawnInstance({
    instanceId: 'ui-check',
    port,
    stateDir: path.join(RUN_DIR, 'ui-check')
  });
  try {
    await waitForReady(instance);
    const base = `http://127.0.0.1:${port}`;

    // 静态界面资源必须可打开，这是“操作界面”的启动入口。
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    const htmlText = await html.text();
    assert.match(htmlText, /<canvas id="map"/);
    const appJs = await fetch(`${base}/app.js`);
    assert.equal(appJs.status, 200);

    const room = await api(base, '/api/matches', { method: 'POST', body: roomBody });
    assert.equal(room.status, 201);
    const matchId = room.json.match.id;

    const join = await api(base, `/api/matches/${matchId}/players`, {
      method: 'POST',
      body: { faction: 'A', role: 'engineer', name: '界面操作员' }
    });
    assert.equal(join.status, 201);
    const playerId = join.json.player.id;
    const generation = join.json.player.generation;

    // 未开始时移动必须被拒绝，失败反馈回到调用方，界面据此弹通知。
    const earlyMove = await api(base, `/api/matches/${matchId}/players/${playerId}/command`, {
      method: 'POST',
      body: { type: 'move', target: { x: 450, y: 450 }, generation }
    });
    assert.equal(earlyMove.status, 409);
    assert.equal(earlyMove.json.code, 'match_not_running');

    await api(base, `/api/matches/${matchId}/start`, { method: 'POST' });

    // 与 app.js 的 onCanvasClick 完全一致：点击地图中心 = move 到据点。
    const move = await api(base, `/api/matches/${matchId}/players/${playerId}/command`, {
      method: 'POST',
      body: { type: 'move', target: { x: 450, y: 450 }, generation }
    });
    assert.equal(move.status, 200);

    let snapshot = null;
    let entered = false;
    let captured = false;
    let scoreSeen = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const response = await api(base, `/api/matches/${matchId}`);
      snapshot = response.json.match;
      if (snapshot.presence.some((row) => row.playerId === playerId)) entered = true;
      const events = (await api(base, `/api/matches/${matchId}/events?since=0`)).json.events;
      captured = events.some((e) => e.type === 'captured' && e.faction === 'A');
      scoreSeen = events.some((e) => e.type === 'score');
      if (entered && captured && scoreSeen) break;
      await wait(250);
    }

    assert.ok(entered, '队员移动后应进入据点并生成参与记录');
    assert.ok(captured, '内核应裁决 A 阵营占领据点');
    assert.ok(scoreSeen, '占领/固守应产生计分事件');
    assert.equal(snapshot.owner, 'A');
    assert.ok(snapshot.scores.A > 0, 'A 阵营应有分数');

    // 无效目标的失败反馈：界面 toast 依赖 error/code 字段。
    const bad = await api(base, `/api/matches/${matchId}/players/${playerId}/command`, {
      method: 'POST',
      body: { type: 'move', target: { x: 'NaN', y: 1 }, generation }
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error && bad.json.code);

    // 停止指令与 SSE 房间关闭事件。
    const stream = await fetch(`${base}/api/matches/${matchId}/stream`);
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const readSome = async () => {
      const { value } = await reader.read();
      buffered += decoder.decode(value, { stream: true });
    };
    await readSome();
    assert.match(buffered, /event: hello/);

    const stop = await api(base, `/api/matches/${matchId}/players/${playerId}/command`, {
      method: 'POST',
      body: { type: 'stop', generation }
    });
    assert.equal(stop.status, 200);

    const del = await api(base, `/api/matches/${matchId}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    await wait(150);
    await readSome().catch(() => {});
    assert.match(buffered, /event: room_closed/, '界面 EventSource 能收到房间关闭通知');
    reader.cancel().catch(() => {});

    console.log('PASS  界面操作链路：移动→争夺→占领→计分→失败反馈→关闭通知');
  } catch (error) {
    console.error('FAIL  界面操作链路自检失败：', error.stack || error.message);
    if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
    process.exitCode = 1;
  } finally {
    if (instance.child.exitCode === null) {
      await stopInstance(instance);
    }
  }
}

main();

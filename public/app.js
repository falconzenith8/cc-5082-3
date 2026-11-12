const FACTIONS = {
  A: { name: '赤焰', color: '#ff6363' },
  B: { name: '苍蓝', color: '#58a6ff' },
  C: { name: '金戈', color: '#ffc857' }
};

const STATUS_TEXT = {
  eligible: '有资格',
  suppressed: '压制中',
  suppressed_ineligible: '压制·无资格',
  ineligible: '无资格',
  down: '阵亡',
  unknown: '未知'
};

const MOMENTUM_TEXT = {
  idle: '待开始',
  empty: '空场',
  pinned: '无有效资格',
  deadlock: '多方僵持',
  contested: '多方争夺',
  solo: '单方推进'
};

const EVENT_TYPES = [
  'match_start',
  'match_end',
  'player_joined',
  'player_left',
  'faction_switch',
  'presence_enter',
  'presence_exit',
  'participants_reinterpreted',
  'hit',
  'down',
  'respawn',
  'captured',
  'score',
  'hold_skipped'
];

const state = {
  matches: [],
  matchId: null,
  snapshot: null,
  myPlayerId: null,
  selectedFaction: 'A',
  selectedRole: 'vanguard',
  source: null,
  lastSeq: 0,
  feed: [],
  replay: null,
  replayPlaying: false,
  replayTime: 0,
  noticeTimer: null,
  roles: {}
};

const el = {
  matchSelect: document.getElementById('match-select'),
  newMatch: document.getElementById('new-match'),
  phase: document.getElementById('phase-label'),
  clock: document.getElementById('clock-label'),
  barFill: document.getElementById('bar-fill'),
  barTicks: document.getElementById('bar-ticks'),
  owner: document.getElementById('owner-label'),
  momentum: document.getElementById('momentum-label'),
  challengerLabel: document.getElementById('challenger-label'),
  weightLabel: document.getElementById('weight-label'),
  scoreboard: document.getElementById('scoreboard'),
  canvas: document.getElementById('map'),
  playerSelect: document.getElementById('player-select'),
  roleButtons: document.getElementById('role-buttons'),
  factionButtons: document.getElementById('faction-buttons'),
  join: document.getElementById('join'),
  switchFaction: document.getElementById('switch-faction'),
  start: document.getElementById('start'),
  end: document.getElementById('end'),
  addUnit: document.getElementById('add-unit'),
  leave: document.getElementById('leave'),
  presence: document.getElementById('presence-list'),
  presenceEmpty: document.getElementById('presence-empty'),
  feed: document.getElementById('event-feed'),
  eventCount: document.getElementById('event-count'),
  loadReplay: document.getElementById('load-replay'),
  exitReplay: document.getElementById('exit-replay'),
  replayToggle: document.getElementById('replay-toggle'),
  replaySeek: document.getElementById('replay-seek'),
  replayTime: document.getElementById('replay-time'),
  replayNote: document.getElementById('replay-note'),
  notice: document.getElementById('notice')
};

const ctx = el.canvas.getContext('2d');

init();

function init() {
  buildTicks();
  buildFactionButtons();
  buildRoleButtons();
  bindEvents();
  refreshMatches().then(() => {
    const saved = sessionStorage.getItem('matchId');
    if (saved && state.matches.some((m) => m.id === saved)) {
      selectMatch(saved);
    } else if (state.matches[0]) {
      selectMatch(state.matches[0].id);
    } else {
      createMatch();
    }
  });
  requestAnimationFrame(loop);
}

function bindEvents() {
  el.newMatch.addEventListener('click', createMatch);
  el.matchSelect.addEventListener('change', () => selectMatch(el.matchSelect.value));
  el.playerSelect.addEventListener('change', () => {
    state.myPlayerId = el.playerSelect.value || null;
    if (state.matchId && state.myPlayerId) {
      sessionStorage.setItem(`myPlayer:${state.matchId}`, state.myPlayerId);
    }
    renderAll();
  });
  el.join.addEventListener('click', joinMatch);
  el.switchFaction.addEventListener('click', switchFaction);
  el.start.addEventListener('click', () => matchAction('start'));
  el.end.addEventListener('click', () => matchAction('end'));
  el.addUnit.addEventListener('click', addDrillUnit);
  el.leave.addEventListener('click', leaveMatch);
  el.loadReplay.addEventListener('click', loadReplay);
  el.exitReplay.addEventListener('click', () => {
    if (state.replay) exitReplay();
    else showNotice('当前未在回放模式');
  });
  el.replayToggle.addEventListener('click', toggleReplay);
  el.replaySeek.addEventListener('input', () => {
    if (!state.replay) return;
    state.replayTime = Number(el.replaySeek.value) / 1000 * state.replay.durationMs;
    stopReplayPlayback();
    renderReplay(true);
  });
  el.canvas.addEventListener('click', onCanvasClick);
  window.addEventListener('resize', () => renderAll());
}

/* ---------- 数据层 ---------- */

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.error || `请求失败（${response.status}）`;
    throw Object.assign(new Error(message), { status: response.status, payload });
  }
  return payload;
}

async function refreshMatches() {
  const payload = await api('/api/matches');
  state.matches = payload.matches;
  renderMatchSelect();
}

async function createMatch() {
  try {
    const payload = await api('/api/matches', {
      method: 'POST',
      body: { name: `对局 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` }
    });
    await refreshMatches();
    selectMatch(payload.match.id);
  } catch (error) {
    showNotice(error.message);
  }
}

async function selectMatch(id) {
  if (!id) return;
  if (state.replay) exitReplay();
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  state.matchId = id;
  sessionStorage.setItem('matchId', id);
  // 每场对局各自记录玩家身份，切换对局时不会误操控另一场的角色。
  state.myPlayerId = sessionStorage.getItem(`myPlayer:${id}`) || null;
  state.feed = [];
  state.lastSeq = 0;
  state.snapshot = null;
  el.matchSelect.value = id;

  try {
    const payload = await api(`/api/matches/${id}/events?since=0`);
    state.feed = payload.events.slice(-80);
    state.lastSeq = state.feed.at(-1)?.seq || 0;
    const snapshot = await api(`/api/matches/${id}`);
    applySnapshot(snapshot.match);
  } catch (error) {
    showNotice(error.message);
    return;
  }
  connectStream(id);
  renderAll();
}

function connectStream(id) {
  if (state.source) state.source.close();
  const source = new EventSource(`/api/matches/${id}/stream`);
  state.source = source;

  source.addEventListener('hello', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.match) applySnapshot(payload.match);
  });
  source.addEventListener('state', (event) => {
    const payload = JSON.parse(event.data);
    if (state.replay) return;
    if (payload.snapshot) applySnapshot(payload.snapshot);
  });
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      const record = JSON.parse(event.data);
      if (state.replay) return;
      ingestEvent(record);
    });
  }
  source.onerror = () => {
    // EventSource 会自动重连；这里只提示，不中断对局。
    el.phase.classList.add('stale');
  };
}

function ingestEvent(record) {
  if (record.seq <= state.lastSeq) return;
  state.lastSeq = record.seq;
  state.feed.push(record);
  if (state.feed.length > 80) state.feed = state.feed.slice(-80);
  renderFeed(state.feed);
  el.eventCount.textContent = String(state.feed.length);
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  if (snapshot.roles) state.roles = snapshot.roles;
  renderAll();
}

async function matchAction(action) {
  try {
    await api(`/api/matches/${state.matchId}/${action}`, { method: 'POST' });
  } catch (error) {
    showNotice(error.message);
  }
}

async function joinMatch() {
  try {
    if (state.snapshot?.phase !== 'lobby') {
      showNotice('对局已开始，不能加入新角色');
      return;
    }
    const payload = await api(`/api/matches/${state.matchId}/players`, {
      method: 'POST',
      body: { faction: state.selectedFaction, role: state.selectedRole }
    });
    state.myPlayerId = payload.player.id;
    sessionStorage.setItem(`myPlayer:${state.matchId}`, payload.player.id);
    renderAll();
  } catch (error) {
    showNotice(error.message);
  }
}

async function switchFaction() {
  const me = myPlayer();
  if (!me) {
    showNotice('请先加入对局或选择操作角色');
    return;
  }
  if (state.snapshot?.phase === 'ended') {
    showNotice('对局已结束，不能切换阵营');
    return;
  }
  if (me.faction === state.selectedFaction) {
    showNotice('当前角色已在该阵营');
    return;
  }
  try {
    await api(`/api/matches/${state.matchId}/players/${me.id}/faction`, {
      method: 'POST',
      body: { faction: state.selectedFaction }
    });
  } catch (error) {
    showNotice(error.message);
  }
}

async function addDrillUnit() {
  // 演练单位仍是服务端实体，需通过指令移动，不使用本地定时动画。
  try {
    const payload = await api(`/api/matches/${state.matchId}/players`, {
      method: 'POST',
      body: {
        faction: state.selectedFaction,
        role: state.selectedRole,
        name: `演练${state.selectedFaction}`
      }
    });
    showNotice(`已加入演练单位 ${payload.player.slot}，可在“操作角色”中切换操控`);
  } catch (error) {
    showNotice(error.message);
  }
}

async function leaveMatch() {
  const me = myPlayer();
  if (!me) {
    showNotice('请先选择操作角色');
    return;
  }
  try {
    await api(`/api/matches/${state.matchId}/players/${me.id}`, { method: 'DELETE' });
    if (state.myPlayerId === me.id) {
      state.myPlayerId = null;
      sessionStorage.removeItem(`myPlayer:${state.matchId}`);
    }
    renderAll();
  } catch (error) {
    showNotice(error.message);
  }
}

async function sendCommand(command) {
  const me = myPlayer();
  if (!me || !state.snapshot || state.snapshot.phase !== 'running') return;
  if (!me.alive) {
    showNotice('角色尚未复活');
    return;
  }
  try {
    await api(`/api/matches/${state.matchId}/players/${me.id}/command`, {
      method: 'POST',
      body: { ...command, generation: me.generation }
    });
    if (command.type === 'move') {
      const mine = state.snapshot.players.find((p) => p.id === me.id);
      if (mine) mine.target = command.target;
      draw();
    }
  } catch (error) {
    showNotice(error.message);
  }
}

/* ---------- 输入 ---------- */

function myPlayer() {
  if (!state.snapshot || !state.myPlayerId) return null;
  return state.snapshot.players.find((p) => p.id === state.myPlayerId) || null;
}

function worldPoint(event) {
  const snapshot = activeView();
  const world = snapshot?.map || { width: 900, height: 900 };
  const rect = el.canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * world.width;
  const y = ((event.clientY - rect.top) / rect.height) * world.height;
  return { x, y };
}

function onCanvasClick(event) {
  if (state.replay) {
    showNotice('回放模式下不能发送指令');
    return;
  }
  const snapshot = state.snapshot;
  if (!snapshot || snapshot.phase !== 'running') {
    showNotice(snapshot?.phase === 'ended' ? '对局已结束' : '对局尚未开始');
    return;
  }
  const me = myPlayer();
  if (!me) {
    showNotice('请先加入对局或选择操作角色');
    return;
  }
  const point = worldPoint(event);
  const clicked = pickPlayer(snapshot.players, point);
  if (clicked && clicked.id !== me.id && clicked.faction !== me.faction && clicked.alive) {
    sendCommand({ type: 'fire', targetPlayerId: clicked.id });
    return;
  }
  sendCommand({ type: 'move', target: point });
}

function pickPlayer(players, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const player of players) {
    const distance = Math.hypot(player.x - point.x, player.y - point.y);
    if (distance <= 22 && distance < bestDistance) {
      best = player;
      bestDistance = distance;
    }
  }
  return best;
}

/* ---------- 渲染 ---------- */

function loop() {
  if (state.replayPlaying) advanceReplay();
  if (!state.replay) draw();
  requestAnimationFrame(loop);
}

function renderAll() {
  renderMatchSelect();
  renderPlayerSelect();
  renderPresence();
  renderFeed(state.feed);
  updateHud(activeView());
  draw();
}

function activeView() {
  if (state.replay) return replayView();
  return state.snapshot;
}

function draw() {
  const view = activeView();
  const world = view?.map || { width: 900, height: 900 };
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (el.canvas.width !== world.width * dpr) {
    el.canvas.width = world.width * dpr;
    el.canvas.height = world.height * dpr;
  }
  ctx.setTransform(el.canvas.width / world.width, 0, 0, el.canvas.height / world.height, 0, 0);
  ctx.clearRect(0, 0, world.width, world.height);

  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(0, 0, world.width, world.height);
  drawGrid(world);
  if (!view) {
    ctx.fillStyle = '#5d6b7c';
    ctx.font = '16px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待对局数据…', world.width / 2, world.height / 2);
    return;
  }
  drawSpawns(view.spawns || {});
  drawObstacles(view.obstacles || []);
  drawPoint(view);
  drawPlayers(view);
  drawTargetMarker(view);
}

function drawGrid(world) {
  ctx.strokeStyle = 'rgba(120, 150, 190, 0.07)';
  ctx.lineWidth = 1;
  const gap = 60;
  for (let x = gap; x < world.width; x += gap) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, world.height);
    ctx.stroke();
  }
  for (let y = gap; y < world.height; y += gap) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(world.width, y);
    ctx.stroke();
  }
}

function drawSpawns(spawns) {
  for (const [faction, spawn] of Object.entries(spawns)) {
    const color = FACTIONS[faction]?.color || '#888';
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(spawn.x, spawn.y, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(spawn.x, spawn.y, 46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = 'bold 15px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${faction} · ${FACTIONS[faction]?.name || ''}`, spawn.x, spawn.y + 66);
  }
}

function drawObstacles(obstacles) {
  for (const rect of obstacles) {
    roundRect(rect.x, rect.y, rect.w, rect.h, 6);
    ctx.fillStyle = '#1a2331';
    ctx.fill();
    ctx.strokeStyle = '#2d3a4d';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawPoint(view) {
  const point = view.point || { x: 450, y: 450, radius: 112 };
  const owner = view.owner;
  const ownerColor = owner ? FACTIONS[owner].color : '#5c6b7e';
  const progress = Math.max(0, Math.min(100, view.progress || 0));
  const challenger = view.challenger || view.activeChallenger || null;
  const speed = view.momentum?.speed || 0;
  const momentumKind = view.momentum?.kind;

  ctx.save();
  ctx.globalAlpha = owner ? 0.08 : 0.03;
  ctx.fillStyle = ownerColor;
  ctx.beginPath();
  ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = owner ? ownerColor : '#3b4a5d';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
  ctx.stroke();

  if (momentumKind === 'contested' || momentumKind === 'deadlock') {
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = '#ffb4a2';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(point.x, point.y, point.radius - 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (progress > 0) {
    const pushing = speed > 0;
    const arcColor = pushing
      ? FACTIONS[challenger || owner]?.color || '#7ee0c1'
      : owner
        ? FACTIONS[owner].color
        : '#7ee0c1';
    ctx.strokeStyle = arcColor;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(point.x, point.y, point.radius - 2, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progress) / 100);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  ctx.fillStyle = owner ? ownerColor : '#728094';
  ctx.font = 'bold 22px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(owner ? FACTIONS[owner].name : '中立', point.x, point.y - 6);
  ctx.fillStyle = '#9fb0c3';
  ctx.font = '12px "PingFang SC", sans-serif';
  const sub = progress > 0
    ? `${momentumKind === 'contested' ? '争夺 ' : ''}${Math.round(progress)}%`
    : owner
      ? '控制中'
      : '待占领';
  ctx.fillText(sub, point.x, point.y + 18);
  ctx.textBaseline = 'alphabetic';
}

function drawPlayers(view) {
  const presence = new Set((view.presence || []).map((row) => row.playerId));
  for (const player of view.players || []) {
    const color = FACTIONS[player.faction]?.color || '#999';
    const radius = 13;
    if (!player.alive) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = '#63707f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(player.x - 6, player.y - 6);
      ctx.lineTo(player.x + 6, player.y + 6);
      ctx.moveTo(player.x + 6, player.y - 6);
      ctx.lineTo(player.x - 6, player.y + 6);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    if (presence.has(player.id)) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#dff6ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(player.x, player.y, radius + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = player.suppressed ? '#3a2a2a' : color;
    ctx.fill();
    ctx.lineWidth = player.suppressed ? 2 : 1.5;
    ctx.strokeStyle = player.suppressed ? '#ff9f7a' : '#0a0e14';
    if (player.suppressed) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (player.suppressed) {
      ctx.fillStyle = '#ff9f7a';
      ctx.font = 'bold 11px "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('压', player.x, player.y + 4);
    } else {
      ctx.fillStyle = '#0a0e14';
      ctx.font = 'bold 12px "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(roleShort(player.role), player.x, player.y + 4);
    }

    const barWidth = 30;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(player.x - barWidth / 2, player.y + radius + 4, barWidth, 4);
    ctx.fillStyle = player.hp > 40 ? '#7ee0c1' : '#ff7a7a';
    ctx.fillRect(player.x - barWidth / 2, player.y + radius + 4, barWidth * (player.hp / 100), 4);

    ctx.fillStyle = '#c9d6e5';
    ctx.font = '11px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(player.name || player.slot || player.id, player.x, player.y - radius - 8);

    if (player.id === state.myPlayerId && !state.replay) {
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(player.x, player.y, radius + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function drawTargetMarker(view) {
  if (state.replay) return;
  const me = myPlayer();
  if (!me || !me.target) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(126, 224, 193, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(me.x, me.y);
  ctx.lineTo(me.target.x, me.target.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(me.target.x, me.target.y, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function roleShort(roleId) {
  const role = state.roles[roleId];
  if (role?.short) return role.short;
  return { vanguard: '突', engineer: '工', support: '支' }[roleId] || '?';
}

/* ---------- HUD 与面板 ---------- */

function updateHud(view) {
  if (!view) {
    el.phase.textContent = '载入中';
    return;
  }
  const phaseText = { lobby: '就绪', running: '进行中', ended: '已结束' }[view.phase] || view.phase;
  el.phase.textContent = phaseText;
  el.phase.classList.toggle('live', view.phase === 'running');

  const remaining = state.replay
    ? Math.max(0, (view.durationMs || 0) - state.replayTime)
    : view.remainingMs ?? 0;
  el.clock.textContent = formatClock(remaining);

  const progress = Math.max(0, Math.min(100, view.progress || 0));
  const owner = view.owner;
  const challenger = view.challenger || view.activeChallenger || null;
  const mode = view.momentum?.mode;
  const pushing = (view.momentum?.speed || 0) > 0;
  const barColor = pushing && challenger
    ? FACTIONS[challenger].color
    : owner
      ? FACTIONS[owner].color
      : '#7ee0c1';
  // 有进度时显示挑战进度；已控制且无争夺时显示满条的控制状态。
  const barWidth = progress > 0 ? progress : owner ? 100 : 0;
  el.barFill.style.width = `${barWidth}%`;
  el.barFill.style.background = barColor;
  el.barFill.style.opacity = progress > 0 ? '1' : owner ? '0.55' : '0.15';

  el.owner.innerHTML = owner
    ? `控制 <strong style="color:${FACTIONS[owner].color}">${FACTIONS[owner].name} ${owner}</strong>`
    : '未占领';
  const kind = view.momentum?.kind;
  const net = view.momentum?.net;
  el.momentum.textContent = [
    MOMENTUM_TEXT[kind] || '空场',
    net !== undefined && kind === 'contested' ? `净值 ${net}` : '',
    mode === 'defend' ? '控制方压制挑战' : '',
    mode === 'recover' ? '修复进度' : ''
  ]
    .filter(Boolean)
    .join(' · ');

  el.challengerLabel.textContent = challenger
    ? `挑战方 ${FACTIONS[challenger]?.name || challenger} ${challenger}`
    : owner
      ? '无挑战方'
      : '等待占领';
  const weights = view.momentum?.weights || {};
  const active = Object.keys(weights).filter((id) => weights[id] > 0);
  el.weightLabel.textContent = active.length
    ? active.map((id) => `${id} ${weights[id]}`).join(' / ')
    : '有效权重 0';

  renderScoreboard(view);
}

function renderScoreboard(view) {
  el.scoreboard.innerHTML = '';
  const scores = view.scores || {};
  const toWin = view.scoreToWin || 200;
  for (const faction of Object.keys(FACTIONS)) {
    const chip = document.createElement('div');
    chip.className = 'score-chip' + (view.owner === faction ? ' owner' : '');
    chip.style.color = FACTIONS[faction].color;
    chip.innerHTML = `
      <span class="faction">${faction} · ${FACTIONS[faction].name}</span>
      <span class="points">${scores[faction] ?? 0}<small style="font-size:11px;color:#7d8ea3"> / ${toWin}</small></span>
    `;
    el.scoreboard.appendChild(chip);
  }
}

function renderPresence() {
  const view = state.replay ? replayView() : state.snapshot;
  const rows = presenceRows(view);
  el.presence.innerHTML = '';
  el.presenceEmpty.hidden = rows.length > 0;
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'presence-row';
    item.innerHTML = `
      <span class="dot" style="background:${FACTIONS[row.faction]?.color || '#888'}"></span>
      <span class="who">${escapeHtml(row.name || row.playerId)}
        <small>${row.slot} · ${roleLabel(row.role)}</small></span>
      <span class="status ${row.status}">${STATUS_TEXT[row.status] || row.status}${
        row.captureWeight > 0 ? ` ${row.captureWeight}` : ''
      }</span>
    `;
    el.presence.appendChild(item);
  }
}

function presenceRows(view) {
  if (!view) return [];
  if (view.presence && view.presence.length > 0 && view.presence[0].status) {
    return view.presence;
  }
  // 回放关键帧只记录参与身份，按角色权重重建展示。
  return (view.presence || []).map((row) => {
    const role = state.roles[row.role] || { captureWeight: 1, name: '突击手' };
    return {
      ...row,
      name: row.playerId,
      status: role.captureWeight > 0 ? 'eligible' : 'ineligible',
      captureWeight: role.captureWeight
    };
  });
}

function renderFeed(events) {
  el.feed.innerHTML = '';
  const source = state.replay
    ? state.replay.events.filter((event) => event.atMs <= state.replayTime).slice(-30)
    : events.slice(-30);
  for (const event of source) {
    const item = document.createElement('li');
    if (event.type === 'score') item.classList.add('score');
    item.innerHTML = `
      <span class="t">${((event.atMs || 0) / 1000).toFixed(1)}s</span>
      <span>${describeEvent(event)}</span>
    `;
    el.feed.prepend(item);
  }
  el.eventCount.textContent = String(source.length);
}

function describeEvent(event) {
  const factionTag = (id) => (id ? `<strong style="color:${FACTIONS[id]?.color || '#fff'}">${FACTIONS[id]?.name || id} ${id}</strong>` : '');
  switch (event.type) {
    case 'match_start':
      return '<strong>对局开始</strong>';
    case 'match_end':
      return `<strong>对局结束</strong> · ${endReasonText(event.reason)}${
        event.winner ? ` · 胜者 ${factionTag(event.winner)}` : ''
      }`;
    case 'player_joined':
      return `${escapeHtml(event.name)} 加入 ${factionTag(event.faction)}（${roleLabel(event.role)}）`;
    case 'player_left':
      return `${escapeHtml(event.name)} 离开对局`;
    case 'faction_switch':
      return `${escapeHtml(event.name)} 由 ${factionTag(event.from)} 换至 ${factionTag(event.to)}`;
    case 'presence_enter':
      return `${escapeHtml(event.name || event.playerId)} 进入据点 · ${roleLabel(event.role)}`;
    case 'presence_exit':
      return `${escapeHtml(event.slot || event.playerId)} 离开据点（${exitReason(event.reason)}）`;
    case 'participants_reinterpreted': {
      const weights = Object.entries(event.eligible || {})
        .filter(([, value]) => value > 0)
        .map(([faction, value]) => `${faction} ${value}`)
        .join(' / ');
      return `重新解释有效参与者 · ${event.reason === 'faction_switch' ? '换阵营' : '离场'}后权重 ${
        weights || '0'
      }`;
    }
    case 'hit':
      return `${escapeHtml(event.attacker)} 压制 ${escapeHtml(event.target)} · 剩余 ${event.hp}`;
    case 'down':
      return `${escapeHtml(event.playerId)} 被击倒 · 参与记录${event.presenceReleased ? '已释放' : '未释放'}`;
    case 'respawn':
      return `${escapeHtml(event.playerId)} 复活 · 新身份 #${event.generation}`;
    case 'captured':
      return `<strong>${factionTag(event.faction)} 占领据点</strong>${
        event.fromFaction ? `（原 ${factionTag(event.fromFaction)}）` : ''
      }`;
    case 'score':
      return `${factionTag(event.faction)} +${event.amount} 分 · ${
        event.reason === 'hold' ? `固守结算 #${event.bucket}` : '占领奖励'
      } → 总分 ${event.total}`;
    case 'hold_skipped':
      return `跳过计分 #${event.bucket} · ${skipReason(event.reason)}`;
    default:
      return event.type;
  }
}

function exitReason(reason) {
  return { moved_out: '走出区域', left: '离场', faction_switch: '切换阵营', downed: '被击倒' }[reason] || reason;
}

function endReasonText(reason) {
  return { score: '达到胜利分', timeout: '比赛时间耗尽', manual: '手动结束' }[reason] || reason;
}

function skipReason(reason) {
  return {
    unowned: '无人控制',
    under_contest: '控制方正在被争夺',
    contested_presence: '据点处于多方争夺',
    owner_absent: '控制方无人在场'
  }[reason] || reason;
}

function roleLabel(roleId) {
  return state.roles[roleId]?.name || { vanguard: '突击手', engineer: '工兵', support: '支援' }[roleId] || roleId || '未知';
}

/* ---------- 选择器 ---------- */

function renderMatchSelect() {
  const current = state.matchId;
  el.matchSelect.innerHTML = '';
  for (const match of state.matches) {
    const option = document.createElement('option');
    option.value = match.id;
    const phaseText = { lobby: '就绪', running: '进行中', ended: '已结束' }[match.phase] || match.phase;
    option.textContent = `${match.name} · ${phaseText} · ${match.players}人`;
    el.matchSelect.appendChild(option);
  }
  if (current) el.matchSelect.value = current;
}

function renderPlayerSelect() {
  const snapshot = state.snapshot;
  el.playerSelect.innerHTML = '';
  if (!snapshot) {
    el.playerSelect.disabled = true;
    return;
  }
  el.playerSelect.disabled = snapshot.players.length === 0;
  for (const player of snapshot.players) {
    const option = document.createElement('option');
    option.value = player.id;
    option.textContent = `${player.slot} · ${player.name}（${roleLabel(player.role)}，${STATUS_TEXT[player.status] || player.status}）`;
    el.playerSelect.appendChild(option);
  }
  const me = myPlayer();
  if (me) el.playerSelect.value = me.id;

  el.join.disabled = snapshot.phase !== 'lobby';
  el.switchFaction.disabled = snapshot.phase === 'ended' || snapshot.players.length === 0;
  el.start.disabled = snapshot.phase !== 'lobby' || snapshot.players.length === 0;
  el.end.disabled = snapshot.phase !== 'running';
  el.addUnit.disabled = snapshot.phase !== 'lobby';
  el.replayToggle.disabled = !state.replay;
  el.replaySeek.disabled = !state.replay;
}

function buildFactionButtons() {
  const container = el.factionButtons;
  if (!container) return;
  for (const [id, faction] of Object.entries(FACTIONS)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${id} ${faction.name}`;
    button.style.color = faction.color;
    button.classList.toggle('active', id === state.selectedFaction);
    button.addEventListener('click', () => {
      state.selectedFaction = id;
      [...container.children].forEach((child) => child.classList.toggle('active', child === button));
    });
    container.appendChild(button);
  }
}

function buildRoleButtons() {
  const roles = [
    { id: 'vanguard', name: '突击手', weight: '1×' },
    { id: 'engineer', name: '工兵', weight: '1.5×' },
    { id: 'support', name: '支援', weight: '无资格' }
  ];
  for (const role of roles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${role.name} · ${role.weight}`;
    button.classList.toggle('active', role.id === state.selectedRole);
    button.addEventListener('click', () => {
      state.selectedRole = role.id;
      [...el.roleButtons.children].forEach((child) => child.classList.toggle('active', child === button));
    });
    el.roleButtons.appendChild(button);
  }
}

function buildTicks() {
  for (let i = 0; i < 6; i += 1) {
    const tick = document.createElement('span');
    el.barTicks.appendChild(tick);
  }
}

/* ---------- 回放 ---------- */

async function loadReplay() {
  try {
    const replay = await api(`/api/matches/${state.matchId}/replay`);
    state.replay = replay;
    state.replayTime = 0;
    state.replayPlaying = false;
    el.replayToggle.textContent = '播放';
    el.replayNote.textContent = `已载入 ${replay.events.length} 个事件 / ${replay.frames.length} 个关键帧，点击播放或拖动进度。`;
    el.replaySeek.max = '1000';
    el.replaySeek.value = '0';
    renderAll();
  } catch (error) {
    showNotice(error.message);
  }
}

function exitReplay() {
  stopReplayPlayback();
  state.replay = null;
  el.replayNote.textContent = '载入回放后可按事件时间轴定位。';
  el.replayToggle.textContent = '播放';
  el.replaySeek.value = '0';
  renderAll();
}

function toggleReplay() {
  if (!state.replay) return;
  if (state.replayTime >= state.replay.durationMs) state.replayTime = 0;
  state.replayPlaying = !state.replayPlaying;
  el.replayToggle.textContent = state.replayPlaying ? '暂停' : '播放';
  el.replayNote.textContent = state.replayPlaying ? '回放播放中（实时数据暂停显示）' : '回放已暂停';
}

function stopReplayPlayback() {
  state.replayPlaying = false;
  el.replayToggle.textContent = '播放';
}

let lastReplayFrameAt = null;
function advanceReplay() {
  const now = performance.now();
  if (lastReplayFrameAt === null) lastReplayFrameAt = now;
  const delta = Math.min(250, now - lastReplayFrameAt);
  lastReplayFrameAt = now;
  state.replayTime += delta;
  if (state.replayTime >= state.replay.durationMs) {
    state.replayTime = state.replay.durationMs;
    stopReplayPlayback();
  }
  el.replaySeek.value = String(Math.round((state.replayTime / state.replay.durationMs) * 1000));
  renderReplay(false);
}

function renderReplay(force) {
  if (!state.replay) return;
  if (force) lastReplayFrameAt = null;
  el.replayTime.textContent = `${(state.replayTime / 1000).toFixed(1)}s`;
  el.replaySeek.value = String(Math.round((state.replayTime / state.replay.durationMs) * 1000));
  draw();
  updateHud(replayView());
  renderPresence();
  renderFeed(state.feed);
}

function replayView() {
  const replay = state.replay;
  if (!replay) return null;
  const frames = replay.frames;
  if (frames.length === 0) {
    return {
      phase: replay.phase,
      owner: replay.owner,
      progress: 0,
      challenger: null,
      momentum: { kind: 'empty', speed: 0, mode: 'hold' },
      scores: replay.scores,
      scoreToWin: replay.scoreToWin,
      durationMs: replay.durationMs,
      remainingMs: Math.max(0, replay.durationMs - state.replayTime),
      players: [],
      presence: [],
      map: replay.map,
      point: replay.point,
      spawns: replay.spawns,
      obstacles: replay.obstacles
    };
  }
  const t = state.replayTime;
  let index = 0;
  while (index < frames.length - 1 && frames[index + 1].atMs <= t) index += 1;
  const from = frames[index];
  const to = frames[Math.min(frames.length - 1, index + 1)];
  const span = Math.max(1, to.atMs - from.atMs);
  const alpha = Math.max(0, Math.min(1, (t - from.atMs) / span));
  const playersById = new Map(from.players.map((player) => [player.id, player]));
  const players = from.players.map((player) => {
    const next = to.players.find((candidate) => candidate.id === player.id) || player;
    const interpolated = next.generation === player.generation;
    return {
      ...player,
      x: interpolated ? lerp(player.x, next.x, alpha) : player.x,
      y: interpolated ? lerp(player.y, next.y, alpha) : player.y,
      hp: next.hp,
      alive: next.alive,
      suppressed: next.suppressed,
      name: player.id
    };
  });
  for (const player of to.players) {
    if (!playersById.has(player.id)) players.push(player);
  }
  const progress = lerp(from.progress, to.progress, alpha);
  return {
    phase: from.phase,
    owner: from.owner,
    progress,
    challenger: from.challenger,
    momentum: from.momentum,
    scores: from.scores,
    scoreToWin: replay.scoreToWin,
    durationMs: replay.durationMs,
    remainingMs: Math.max(0, replay.durationMs - t),
    players,
    presence: from.presence,
    map: replay.map,
    point: replay.point,
    spawns: replay.spawns,
    obstacles: replay.obstacles
  };
}

/* ---------- 工具 ---------- */

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function showNotice(message) {
  el.notice.textContent = message;
  el.notice.hidden = false;
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => {
    el.notice.hidden = true;
  }, 2400);
}

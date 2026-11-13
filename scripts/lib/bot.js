// 模拟角色：仅通过 HTTP 指令与服务交互，移动、射击、争夺全部走据点内核裁决。

export class BotClient {
  constructor(baseUrl, { name = 'bot', seed = 1, pollMs = 200, fetchImpl = globalThis.fetch } = {}) {
    this.base = baseUrl.replace(/\/$/, '');
    this.name = name;
    this.seed = seed >>> 0 || 1;
    this.pollMs = pollMs;
    this.fetch = fetchImpl;
    this.timer = null;
    this.running = false;
    this.playerId = null;
    this.matchId = null;
    this.lastSnapshot = null;
    this.lastError = null;
    this.errors = [];
    this.rejectedCommands = [];
    this.ticks = 0;
  }

  // 可复现的线性同余随机，保证两个实例上的模拟对局行为一致。
  random() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.base}${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    return { status: response.status, json };
  }

  async join(matchId, faction, role = 'vanguard') {
    this.matchId = matchId;
    const { status, json } = await this.request(`/api/matches/${matchId}/players`, {
      method: 'POST',
      body: { faction, role, name: this.name }
    });
    if (status !== 201) {
      const error = new Error(json?.error || `加入失败：${status}`);
      error.status = status;
      error.code = json?.code;
      throw error;
    }
    this.playerId = json.player.id;
    this.generation = json.player.generation;
    return json.player;
  }

  async command(body) {
    const { status, json } = await this.request(
      `/api/matches/${this.matchId}/players/${this.playerId}/command`,
      { method: 'POST', body: { ...body, generation: this.generation } }
    );
    if (status >= 400) {
      this.rejectedCommands.push({ status, code: json?.code, body });
      this.lastError = json?.error;
    }
    return { status, json };
  }

  decide(snapshot) {
    const me = snapshot.players.find((p) => p.id === this.playerId);
    if (!me) return null;
    this.generation = me.generation;
    if (!me.alive || snapshot.phase !== 'running') return null;

    // 射程内有敌人就射击（支援角色也能压制，只是不能占领）。
    const enemy = (snapshot.players || [])
      .filter((p) => p.alive && p.faction !== me.faction)
      .map((p) => ({ p, d: Math.hypot(p.x - me.x, p.y - me.y) }))
      .filter((row) => row.d <= 230)
      .sort((a, b) => a.d - b.d)[0];
    if (enemy && this.random() < 0.6) {
      return { type: 'fire', targetPlayerId: enemy.p.id };
    }

    const point = snapshot.point;
    const inside = me.inside === true;
    if (!inside) {
      // 带轻微抖动，避免所有机器人走同一条直线。
      const jitter = 30;
      return {
        type: 'move',
        target: {
          x: point.x + (this.random() - 0.5) * jitter,
          y: point.y + (this.random() - 0.5) * jitter
        }
      };
    }
    // 已在据点内：绕小圈保持争夺，并偶尔换位以体现真实移动。
    const angle = this.ticks * 0.35 + this.seed % 6;
    return {
      type: 'move',
      target: {
        x: point.x + Math.cos(angle) * point.radius * 0.45,
        y: point.y + Math.sin(angle) * point.radius * 0.45
      }
    };
  }

  async pollOnce() {
    const { status, json } = await this.request(`/api/matches/${this.matchId}`);
    if (status !== 200) return null;
    this.lastSnapshot = json.match;
    this.ticks += 1;
    const decision = this.decide(json.match);
    if (decision) await this.command(decision);
    return json.match;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.running = false;
        this.lastError = error.message;
        this.errors.push(error.message);
      });
    }, this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export async function waitForPhase(base, matchId, phase, { timeoutMs = 60000, intervalMs = 250, fetchImpl = globalThis.fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetchImpl(`${base}/api/matches/${matchId}`);
    const json = await response.json();
    if (json.match.phase === phase) return json.match;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待对局进入 ${phase} 超时`);
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchError } from '../engine/config.js';
import { MatchManager } from './manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

export function createServer({
  now = () => Date.now(),
  tickMs = 50,
  maxRooms = 16,
  instanceId = 'default',
  logger = null
} = {}) {
  const manager = new MatchManager({ now, maxRooms });
  manager.startClock(tickMs);
  const startedAtMs = now();

  const server = http.createServer(async (req, res) => {
    const started = now();
    res.on('finish', () => {
      if (!logger) return;
      logger.log('http', `${req.method} ${req.url}`, {
        status: res.statusCode,
        durationMs: Math.max(0, now() - started)
      });
    });
    try {
      await route(req, res, manager, now, { instanceId, startedAtMs });
    } catch (error) {
      respondError(res, error);
    }
  });

  server.manager = manager;
  server.shutdown = (reason) => manager.shutdown(reason);
  server.on('close', () => manager.stopClock());
  return server;
}

async function route(req, res, manager, now, meta) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api') {
    return handleApi(req, res, url, parts.slice(1), manager, now, meta);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, url.pathname);
  }

  return sendJson(res, 405, { error: '方法不允许' });
}

async function handleApi(req, res, url, parts, manager, now, meta) {
  if (parts.length === 0) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '方法不允许' });
    return sendJson(res, 200, { matches: manager.list() });
  }

  if (parts[0] === 'health' && parts.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      instanceId: meta.instanceId,
      uptimeMs: Math.max(0, now() - meta.startedAtMs),
      ...manager.stats()
    });
  }

  if (parts[0] === 'stats' && parts.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, { instanceId: meta.instanceId, ...manager.stats() });
  }

  if (parts[0] === 'matches') {
    if (parts.length === 1) {
      if (req.method === 'POST') {
        const body = await readJson(req);
        const match = manager.create({ name: body.name, config: body.config });
        return sendJson(res, 201, { match: match.snapshot() });
      }
      if (req.method === 'GET') return sendJson(res, 200, { matches: manager.list() });
      return sendJson(res, 405, { error: '方法不允许' });
    }

    const match = manager.get(parts[1]);
    const sub = parts[2];
    const tail = parts.slice(3);

    if (sub === undefined) {
      if (req.method === 'GET') return sendJson(res, 200, { match: match.snapshot() });
      if (req.method === 'DELETE') {
        const summary = manager.closeRoom(match.id, 'api_delete');
        return sendJson(res, 200, { ok: true, closed: summary });
      }
      return sendJson(res, 405, { error: '方法不允许' });
    }

    if (sub === 'stream' && req.method === 'GET') {
      return streamMatch(req, res, manager, match);
    }
    if (sub === 'events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const events = Number.isFinite(since)
        ? match.recorder.eventsSince(since)
        : match.recorder.events;
      return sendJson(res, 200, { events, capacity: match.recorder.stats() });
    }
    if (sub === 'replay' && req.method === 'GET') {
      return sendJson(res, 200, match.replayData());
    }
    if (sub === 'players' && req.method === 'POST' && tail.length === 0) {
      const body = await readJson(req);
      const entity = match.addPlayer(
        { faction: body.faction, role: body.role, name: body.name },
        now()
      );
      return sendJson(res, 201, { player: match.playerView(entity, now()) });
    }
    if (sub === 'players' && tail.length === 1 && req.method === 'DELETE') {
      match.removePlayer(tail[0], now());
      return sendJson(res, 200, { ok: true });
    }
    if (sub === 'players' && tail.length === 2 && tail[1] === 'faction' && req.method === 'POST') {
      const body = await readJson(req);
      const entity = match.setFaction(tail[0], body.faction, now());
      return sendJson(res, 200, { player: match.playerView(entity, now()) });
    }
    if (sub === 'players' && tail.length === 2 && tail[1] === 'command' && req.method === 'POST') {
      const body = await readJson(req);
      match.command(tail[0], body, now());
      return sendJson(res, 200, { ok: true });
    }
    if (sub === 'start' && req.method === 'POST') {
      match.start(now());
      return sendJson(res, 200, { match: match.snapshot() });
    }
    if (sub === 'end' && req.method === 'POST') {
      match.end('manual', now());
      return sendJson(res, 200, { match: match.snapshot() });
    }

    return sendJson(res, 404, { error: '未知接口' });
  }

  return sendJson(res, 404, { error: '未知接口' });
}

function streamMatch(req, res, manager, match) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  // 用持久事件 id 让客户端与浏览器断线续传保持一致。
  const write = (event) => {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  res.write('event: hello\n');
  res.write(`data: ${JSON.stringify({ match: match.snapshot(), lastEventId: 0 })}\n\n`);

  const unsubscribe = manager.subscribe(match.id, (payload) => {
    if (res.writableEnded) return;
    if (payload.closed) {
      res.write('event: room_closed\n');
      res.write(`data: ${JSON.stringify({ matchId: payload.matchId, reason: payload.reason })}\n\n`);
      cleanup();
      return;
    }
    for (const event of payload.events) {
      write({ ...event, id: event.seq });
    }
    res.write('event: state\n');
    res.write(`data: ${JSON.stringify({ revision: payload.revision, snapshot: payload.snapshot })}\n\n`);
  }, match.eventSeq - 1);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': keep-alive\n\n');
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}


function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function respondError(res, error) {
  if (error instanceof MatchError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error && error.status === 413) {
    sendJson(res, 413, { error: '请求体过大' });
    return;
  }
  console.error(error);
  sendJson(res, 500, { error: '服务端错误' });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error('请求体过大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MatchError(400, '请求体不是合法 JSON', 'invalid_json');
  }
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  const rel = path.relative(PUBLIC_DIR, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  fs.readFile(target, (error, content) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('未找到资源');
      return;
    }
    const extension = path.extname(target);
    res.writeHead(200, {
      'content-type': MIME[extension] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

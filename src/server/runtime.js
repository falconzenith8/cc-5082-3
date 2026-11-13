import fs from 'node:fs';
import path from 'node:path';
import { createServer } from './index.js';

const DEFAULTS = {
  instanceId: 'local',
  host: '127.0.0.1',
  port: 8080,
  maxRooms: 16,
  tickMs: 50,
  logMaxBytes: 512 * 1024,
  logKeep: 3
};

export function loadRuntimeConfig(configPath, env = process.env) {
  let fileConfig = {};
  if (configPath && fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const numeric = (value) => {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`无效数字配置：${value}`);
    return parsed;
  };
  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    instanceId: env.INSTANCE_ID ?? fileConfig.instanceId ?? DEFAULTS.instanceId,
    host: env.HOST ?? fileConfig.host ?? DEFAULTS.host,
    port: numeric(env.PORT) ?? fileConfig.port ?? DEFAULTS.port,
    maxRooms: numeric(env.MAX_ROOMS) ?? fileConfig.maxRooms ?? DEFAULTS.maxRooms,
    tickMs: numeric(env.TICK_MS) ?? fileConfig.tickMs ?? DEFAULTS.tickMs,
    logMaxBytes: numeric(env.LOG_MAX_BYTES) ?? fileConfig.logMaxBytes ?? DEFAULTS.logMaxBytes,
    logKeep: numeric(env.LOG_KEEP) ?? fileConfig.logKeep ?? DEFAULTS.logKeep,
    stateDir: env.STATE_DIR ?? fileConfig.stateDir
  };
  if (!Number.isInteger(merged.maxRooms) || merged.maxRooms <= 0) {
    throw new Error('MAX_ROOMS 必须是正整数');
  }
  if (!Number.isInteger(merged.logKeep) || merged.logKeep < 0) {
    throw new Error('LOG_KEEP 必须是非负整数');
  }
  return merged;
}

export class RotatingLogger {
  constructor(logFile, { maxBytes, keep }) {
    this.logFile = logFile;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.stream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.logFile).size;
    } catch {
      size = 0;
    }
    if (size < this.maxBytes) return;
    this.stream.end();
    for (let i = this.keep; i >= 1; i -= 1) {
      const current = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`;
      const target = `${this.logFile}.${i}`;
      if (fs.existsSync(current)) {
        if (i >= this.keep && this.keep > 0 && fs.existsSync(target)) fs.rmSync(target);
        if (this.keep > 0) fs.renameSync(current, target);
      }
    }
    if (this.keep === 0 && fs.existsSync(this.logFile)) fs.rmSync(this.logFile);
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
  }

  log(level, message, extra) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(extra ? { extra } : {})
    }) + '\n';
    this.stream.write(line);
    // 写入后再校验：按整行轮转，不截断半行 JSON，因此文件最多超出上限一个日志行。
    this.rotateIfNeeded();
  }

  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

export function acquirePidLock(stateDir, instanceId) {
  const pidFile = path.join(stateDir, `${instanceId}.pid`);
  if (fs.existsSync(pidFile)) {
    const previous = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(previous) && previous > 0 && isProcessAlive(previous)) {
      const error = new Error(`实例 ${instanceId} 已在运行（pid ${previous}）`);
      error.code = 'INSTANCE_LOCKED';
      throw error;
    }
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
  return pidFile;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function runInstance({ configPath = process.env.CONFIG_PATH, env = process.env } = {}) {
  const config = loadRuntimeConfig(configPath, env);
  if (!config.stateDir) {
    throw new Error('缺少 stateDir：请在配置文件或 STATE_DIR 中指定实例状态目录');
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  const pidFile = acquirePidLock(config.stateDir, config.instanceId);
  const logFile = path.join(config.stateDir, `${config.instanceId}.log`);
  const logger = new RotatingLogger(logFile, {
    maxBytes: config.logMaxBytes,
    keep: config.logKeep
  });
  const startedAt = Date.now();
  logger.log('info', '实例启动', { config: { ...config, stateDir: config.stateDir } });

  const server = createServer({
    tickMs: config.tickMs,
    maxRooms: config.maxRooms,
    instanceId: config.instanceId,
    logger
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log('info', '收到关停信号，开始有序清理', { signal });
    const report = server.shutdown(signal);
    logger.log('info', '房间清理完成', { report });
    await new Promise((resolve) => server.close(resolve));
    await logger.close();
    try {
      fs.rmSync(pidFile);
    } catch {
      // 状态目录可能已被外部清理，忽略。
    }
    for (const launcherPid of [path.join(config.stateDir, `${config.instanceId}.launcher.pid`)]) {
      try {
        fs.rmSync(launcherPid);
      } catch {
        // 直接以 node 启动时没有 launcher.pid，忽略。
      }
    }
    const cleanupFile = path.join(config.stateDir, `${config.instanceId}.cleanup.json`);
    fs.writeFileSync(
      cleanupFile,
      JSON.stringify(
        {
          instanceId: config.instanceId,
          signal,
          uptimeMs: Date.now() - startedAt,
          logFile,
          ...report
        },
        null,
        2
      ),
      'utf8'
    );
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const ready = {
    instanceId: config.instanceId,
    host: config.host,
    port: address.port,
    pid: process.pid,
    stateDir: config.stateDir,
    logFile,
    pidFile,
    maxRooms: config.maxRooms,
    logMaxBytes: config.logMaxBytes,
    logKeep: config.logKeep,
    startedAt: new Date(startedAt).toISOString()
  };
  fs.writeFileSync(path.join(config.stateDir, `${config.instanceId}.ready.json`), JSON.stringify(ready, null, 2));
  logger.log('info', 'HTTP 已监听', ready);
  console.log(`[${config.instanceId}] 据点服务已启动：http://${config.host}:${address.port}`);
  return { server, logger, config, ready };
}

export function describeListenError(error) {
  if (error.code === 'EADDRINUSE') {
    return { code: 'PORT_CONFLICT', message: `端口已被占用：${error.message}` };
  }
  if (error.code === 'EACCES') {
    return { code: 'PORT_DENIED', message: `无权绑定端口：${error.message}` };
  }
  return { code: 'LISTEN_FAILED', message: error.message };
}

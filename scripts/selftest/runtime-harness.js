import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// 直接以子进程方式拉起真实服务实例，配置独立状态目录，验证发布包而不是内存对象。
export function spawnInstance({ instanceId, port, stateDir, maxRooms = 3, logMaxBytes = 262144 }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, `${instanceId}.config.json`);
  writeJson(configPath, {
    instanceId,
    host: '127.0.0.1',
    port,
    maxRooms,
    tickMs: 50,
    logMaxBytes,
    logKeep: 2,
    stateDir
  });
  const child = spawn(process.execPath, ['src/server/main.js'], {
    cwd: ROOT,
    env: { ...process.env, CONFIG_PATH: configPath, STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  return {
    instanceId,
    port,
    stateDir,
    configPath,
    child,
    pid: child.pid,
    stdout: () => stdout.join(''),
    stderr: () => stderr.join('')
  };
}

export async function waitForReady(instance, timeoutMs = 10000) {
  const readyFile = path.join(instance.stateDir, `${instance.instanceId}.ready.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      return JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    }
    if (instance.child.exitCode !== null) {
      throw new Error(
        `实例 ${instance.instanceId} 提前退出（code=${instance.child.exitCode}）：${instance.stderr()}`
      );
    }
    await wait(100);
  }
  throw new Error(`等待实例 ${instance.instanceId} 就绪超时`);
}

export async function waitForExit(instance, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) return instance.child.exitCode;
    await wait(100);
  }
  return null;
}

export async function stopInstance(instance, signal = 'SIGTERM', timeoutMs = 10000) {
  if (instance.child.exitCode === null) {
    instance.child.kill(signal);
  }
  const code = await waitForExit(instance, timeoutMs);
  return code;
}

export async function api(base, urlPath, options = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { status: response.status, json };
}

export function dumpDiagnostics(runDir, instances, context) {
  const diagDir = path.join(runDir, 'diagnostics');
  fs.mkdirSync(diagDir, { recursive: true });
  writeJson(path.join(diagDir, 'failure-context.json'), {
    at: new Date().toISOString(),
    ...context
  });
  for (const instance of instances) {
    const target = path.join(diagDir, instance.instanceId);
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.existsSync(instance.stateDir) ? fs.readdirSync(instance.stateDir) : []) {
      fs.copyFileSync(path.join(instance.stateDir, file), path.join(target, file));
    }
    fs.writeFileSync(path.join(target, 'stdout.txt'), instance.stdout());
    fs.writeFileSync(path.join(target, 'stderr.txt'), instance.stderr());
  }
  return diagDir;
}

// 关停后确认进程、PID 锁与清理报告都符合预期，不能只看 HTTP 还能响应。
export function assertBackgroundTasksEnded(instance) {
  const cleanupFile = path.join(instance.stateDir, `${instance.instanceId}.cleanup.json`);
  const pidFile = path.join(instance.stateDir, `${instance.instanceId}.pid`);
  if (!fs.existsSync(cleanupFile)) {
    throw new Error(`实例 ${instance.instanceId} 缺少清理报告 ${cleanupFile}`);
  }
  const report = JSON.parse(fs.readFileSync(cleanupFile, 'utf8'));
  if (report.remainingRooms !== 0 || report.remainingSubscriptions !== 0) {
    throw new Error(`实例 ${instance.instanceId} 清理报告显示残留：${JSON.stringify(report)}`);
  }
  if (fs.existsSync(pidFile)) {
    throw new Error(`实例 ${instance.instanceId} PID 锁未删除：${pidFile}`);
  }
  return report;
}

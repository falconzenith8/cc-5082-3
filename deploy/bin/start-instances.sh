#!/usr/bin/env bash
# 启动两个彼此隔离的据点服务实例（独立端口、独立状态目录与 PID/日志文件）。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

INSTANCES=("alpha" "beta")

for instance in "${INSTANCES[@]}"; do
  CONFIG="deploy/configs/${instance}.json"
  STATE_DIR="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).stateDir || 'run/$instance')")"
  PID_FILE="${STATE_DIR}/${instance}.pid"
  mkdir -p "$STATE_DIR"

  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[${instance}] 已在运行（pid $(cat "$PID_FILE")），跳过启动"
    continue
  fi

  echo "[${instance}] 启动中，配置 ${CONFIG}"
  # 实例的结构化日志由 runtime 写入 STATE_DIR；stdout/stderr 另存便于排查启动期错误。
  CONFIG_PATH="$CONFIG" nohup node src/server/main.js >>"${STATE_DIR}/${instance}.stdout.log" 2>&1 &
  echo $! >"${STATE_DIR}/${instance}.launcher.pid"

  for _ in $(seq 1 50); do
    if [[ -f "${STATE_DIR}/${instance}.ready.json" ]]; then
      break
    fi
    if ! kill -0 "$(cat "${STATE_DIR}/${instance}.launcher.pid")" 2>/dev/null; then
      echo "[${instance}] 进程退出，请查看 ${STATE_DIR}/${instance}.log" >&2
      exit 1
    fi
    sleep 0.1
  done

  if [[ ! -f "${STATE_DIR}/${instance}.ready.json" ]]; then
    echo "[${instance}] 等待就绪超时，请查看 ${STATE_DIR}/${instance}.log" >&2
    exit 1
  fi
  PORT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${STATE_DIR}/${instance}.ready.json','utf8')).port)")"
  echo "[${instance}] 就绪：http://127.0.0.1:${PORT}（状态目录 ${STATE_DIR}）"
done

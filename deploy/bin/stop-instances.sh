#!/usr/bin/env bash
# 有序关停两个实例：发送 SIGTERM 触发 runtime 的逐房间清理，等待 cleanup.json 落地证明后台任务结束。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

INSTANCES=("alpha" "beta")
TIMEOUT_SECONDS="${1:-20}"

for instance in "${INSTANCES[@]}"; do
  CONFIG="deploy/configs/${instance}.json"
  STATE_DIR="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).stateDir || 'run/$instance')")"
  PID_FILE="${STATE_DIR}/${instance}.pid"
  CLEANUP_FILE="${STATE_DIR}/${instance}.cleanup.json"
  rm -f "$CLEANUP_FILE"

  if [[ ! -f "$PID_FILE" ]]; then
    echo "[${instance}] 未找到 PID 文件，视为未运行"
    continue
  fi
  PID="$(cat "$PID_FILE")"
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[${instance}] 进程 ${PID} 已不存在，清理残留 PID 文件"
    rm -f "$PID_FILE"
    continue
  fi

  echo "[${instance}] 向 pid ${PID} 发送 SIGTERM"
  kill -TERM "$PID"

  for _ in $(seq 1 "$((TIMEOUT_SECONDS * 10))"); do
    if [[ -f "$CLEANUP_FILE" ]]; then
      break
    fi
    sleep 0.1
  done

  if [[ ! -f "$CLEANUP_FILE" ]]; then
    echo "[${instance}] 关停超时，未生成 ${CLEANUP_FILE}" >&2
    exit 1
  fi
  if kill -0 "$PID" 2>/dev/null; then
    echo "[${instance}] cleanup.json 已生成但进程仍在，判定异常" >&2
    exit 1
  fi
  echo "[${instance}] 已关停，清理报告：${CLEANUP_FILE}"
  node -e "const r=require('./$CLEANUP_FILE'); console.log(JSON.stringify({rooms:r.rooms.length, remainingRooms:r.remainingRooms, remainingSubscriptions:r.remainingSubscriptions, stoppedClock:r.stoppedClock}, null, 2))"
done

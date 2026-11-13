# 部署与运行指南：本地多对局据点服务

本指南在单机上从零拉起两个**彼此隔离**的据点服务实例，完成一次可重复的完整据点争夺比赛，并给出发布自检、故障注入与清理验证步骤。全程不依赖外部托管服务，仅需 Node.js ≥ 20（开发验证使用 Node 22）。

## 1. 在新目录重建运行包

运行包零运行时依赖（`package.json` 没有 dependencies），把仓库内容复制到新目录即可重建：

```bash
mkdir -p /opt/capture-arena && cd /opt/capture-arena
# 复制仓库全部内容（src/ public/ scripts/ deploy/ package.json Dockerfile 等）
node --version            # 确认 >= 20
npm test                  # 29 个引擎/服务单元测试，应全部通过
```

示例资源与版本固定：

- 运行时：Node ≥ 20，无 npm 依赖需要安装。
- 房间模板：`deploy/resources/room-standard.json`（标准 5 分钟 200 分赛）、`deploy/resources/room-selftest.json`（60 秒 90 分快局，供自检复现）。
- 实例配置：`deploy/configs/alpha.json`、`deploy/configs/beta.json`，分别绑定 `127.0.0.1:18081` 与 `127.0.0.1:18082`，状态目录 `run/alpha`、`run/beta` 互不重叠。

容量限制（配置项，可在实例配置或环境变量中调整）：

| 限制 | 默认值 | 配置键 |
| --- | --- | --- |
| 每实例房间数 | 4（发布配置） | `maxRooms` / `MAX_ROOMS` |
| 单房间事件缓冲 | 4000 条 | 房间 `config.eventLimit` |
| 单房间关键帧缓冲 | 2000 帧 | 房间 `config.frameLimit` |
| 单实例日志文件 | 256 KiB，保留 2 个轮转份 | `logMaxBytes` / `logKeep` |

超限行为：建房返回 `409 room_limit`；事件/关键帧丢弃最旧记录并在 `/api/stats` 累计 `droppedEvents/droppedFrames`；日志按整行 JSON 轮转（不截断半行，单文件最多超出上限一个日志行），保留份数受限，不会无限增长。

## 2. 启动两个隔离实例（明确次序）

启动次序由 `deploy/bin/start-instances.sh` 固定：

1. 读取实例配置，创建独立状态目录；
2. 检查 PID 锁（`<stateDir>/<instance>.pid`），存活实例不重复启动；
3. 后台拉起 `node src/server/main.js`，结构化 JSON 日志写入状态目录；
4. 轮询 `<instance>.ready.json`，就绪后才启动下一个实例。

```bash
npm run instances:start
# [alpha] 就绪：http://127.0.0.1:18081（状态目录 run/alpha）
# [beta]  就绪：http://127.0.0.1:18082（状态目录 run/beta）

curl -s http://127.0.0.1:18081/api/health   # 含 instanceId、房间相位、缓冲与丢弃统计
curl -s http://127.0.0.1:18082/api/health
```

两实例是独立操作系统进程、独立端口、独立状态目录与日志文件，任何一个实例不持有另一个实例的房间状态。

容器等价方式（需要 Docker 时）：`docker compose up --build`，compose 中两个服务使用独立卷 `alpha-state` / `beta-state`、独立端口与健康检查，语义与上面的进程启动完全一致。

## 3. 打开对局操作界面（界面启动方式）

界面不是独立脚本，而是由服务进程托管的静态页面，**先启动实例再用浏览器打开**：

- alpha 实例界面：<http://127.0.0.1:18081/>
- beta 实例界面：<http://127.0.0.1:18082/>

页面顶部可新建/切换房间；Canvas 地图、加入阵营、开始/结束、移动与射击控件全部调用本实例的 HTTP 接口，由据点争夺内核（`src/engine/match.js`）裁决。内核拒绝操作时接口返回 `{error, code}`，界面以通知条形式把失败反馈显示出来（例如未开始时移动返回 `match_not_running`、结束后加入返回 `match_ended`）。房间被关闭时 SSE 推送 `room_closed`，界面提示并刷新房间列表。

## 4. 一次可重复的完整比赛（端到端 walkthrough）

以下命令在 alpha 实例上完成“建房 → 资源分配 → 客户端接入 → 争夺 → 胜负计分 → 清理”的完整闭环，随时可原样重跑。

```bash
BASE=http://127.0.0.1:18081

# 4.1 房间创建（使用示例模板，容量限制随模板生效）
ROOM=$(curl -s -X POST $BASE/api/matches \
  -H 'content-type: application/json' \
  --data @deploy/resources/room-standard.json)
MID=$(node -e "console.log(JSON.parse(process.argv[1]).match.id)" "$ROOM")
echo "房间：$MID"

# 4.2 资源分配：两个阵营各分配 3 个角色（工兵权重 1.5，突击手权重 1）
for role in engineer vanguard vanguard; do
  curl -s -X POST $BASE/api/matches/$MID/players -H 'content-type: application/json' \
    -d "{\"faction\":\"A\",\"role\":\"$role\"}" >/dev/null
done
for role in engineer vanguard vanguard; do
  curl -s -X POST $BASE/api/matches/$MID/players -H 'content-type: application/json' \
    -d "{\"faction\":\"B\",\"role\":\"$role\"}" >/dev/null
done

# 4.3 客户端接入：浏览器打开界面后在“操作角色”选择 p1，
#     或直接用接口代表该客户端发送移动指令（与界面点击地图同一条链路）。
curl -s -X POST $BASE/api/matches/$MID/start -H 'content-type: application/json' >/dev/null
curl -s -X POST $BASE/api/matches/$MID/players/p1/command \
  -H 'content-type: application/json' \
  -d '{"type":"move","target":{"x":450,"y":450},"generation":1}'

# 4.4 观察占领进度与计分事件（界面右侧“计分事件”面板同源）
curl -s "$BASE/api/matches/$MID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).match;console.log({phase:m.phase,owner:m.owner,progress:m.progress,scores:m.scores})})"
curl -s "$BASE/api/matches/$MID/events?since=0" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).events.map(e=>e.type)))"
```

在浏览器里复现同一场比赛：打开 <http://127.0.0.1:18081/>，选中该房间，在“操作角色”里切换不同队员，点击地图地面移动、点击据点内敌方角色射击。占领进度条、控制方、动量与计分事件随内核 tick 实时变化；达到 200 分或 5 分钟到时后内核自动结束并给出胜者（平分时胜者为 `null`）。

## 5. 比赛结束后的清理次序

单房间清理（`DELETE /api/matches/:id`，对应 `MatchManager.closeRoom`）固定次序：

1. 固化最终快照摘要：相位、胜者、终局分数、在场人数、事件/关键帧容量统计；
2. 向该房间全部 SSE 订阅者推送 `room_closed` 并断开流；
3. 注销订阅集合，再把房间移出调度表——之后的全局 tick 不会再驱动它；
4. 摘要写入实例内存的 `closedRooms`，删除响应直接返回该摘要。

实例关停（`npm run instances:stop` 或 `SIGTERM`）次序：

1. 停止全局 tick 时钟；
2. 按房间创建次序逐间执行上面的单房间清理；
3. 关闭日志流、删除 PID 锁；
4. 写出 `<stateDir>/<instance>.cleanup.json`，报告 `remainingRooms: 0`、`remainingSubscriptions: 0`、`stoppedClock: true` 作为后台任务结束的证据。

```bash
npm run instances:stop
# 每个实例打印 { rooms, remainingRooms: 0, remainingSubscriptions: 0, stoppedClock: true }
cat run/alpha/alpha.cleanup.json
```

## 6. 发布自检（必须双实例、真实争夺）

自检脚本会自行寻找空闲端口、在临时目录 `run/selftest-<时间戳>/` 拉起两个真实子进程实例，跑完后自动关停，不占用固定端口：

```bash
npm run selftest      # 11 项，约 1–3 分钟
npm run ui-check      # 界面操作链路专项（静态页面 + 移动/争夺/占领/计分/失败反馈/SSE 关闭）
```

覆盖项：

1. 两个实例独立启动，`/api/health` 健康且实例 ID 不同；
2. 每个实例各跑一场 6 个模拟角色（双阵营工兵+突击手）的真实争夺，验证产生 `captured`/`score`/`match_end` 事件、计分事件总和与快照一致、达到胜利分时有胜者；
3. 在两个实例各再开一间房并打出区域状态，删除另一间房后验证控制权、计分、队员与事件流不被重置（进度只按内核规则连续演进）；
4. 房间中途退出：运行中的房间被删除，返回运行态摘要且实例仍健康；
5. 已结束对局收到迟到的加入/移动/换阵营事件，全部返回 409 且修订号不变；
6. 端口冲突：第三个实例绑定已占用端口，非零退出并输出 `PORT_CONFLICT`，原实例健康不受影响；
7. 房间数量上限：`maxRooms=1` 时第二次建房返回 `409 room_limit`；
8. 日志容量：小容量日志发生轮转，单文件不超上限、保留份数受限；
9. 事件/关键帧容量通过 `/api/stats` 与事件接口的 `capacity` 字段可见；
10. 关停后检查清理报告、PID 锁删除，证明后台任务真正结束（不是只看进程/端口活着）。

**失败时的诊断资料**：任一项失败，脚本把两个实例状态目录的全部文件（日志、ready、配置、stdout/stderr）复制到 `run/selftest-*/diagnostics/<instance>/`，并写出 `failure-context.json`，然后强制结束子进程。健康判定同时包含 HTTP 可达性与游戏状态断言，不会出现“进程还活着但对局已坏”的假通过。

## 7. 故障注入手动复现

```bash
# 端口冲突（先启动实例，再用同端口新状态目录启动第三个）
CONFIG_PATH=/tmp/dup.json node src/server/main.js    # 退出码 1，输出 PORT_CONFLICT

# PID 锁冲突（同状态目录启动两次）
CONFIG_PATH=deploy/configs/alpha.json node src/server/main.js   # INSTANCE_LOCKED

# 房间中途退出
curl -X DELETE http://127.0.0.1:18081/api/matches/$MID          # 返回关闭摘要

# 已结束对局的迟到事件（先等对局结束或 POST /end）
curl -X POST $BASE/api/matches/$MID/end
curl -X POST $BASE/api/matches/$MID/players -H 'content-type: application/json' \
  -d '{"faction":"C","role":"vanguard"}'                        # 409 match_ended
```

## 8. 目录与接口索引

- 内核：`src/engine/`（状态机、资格动量、参与记录、事件/关键帧容量）。
- 服务：`src/server/`（`main.js` 入口、`runtime.js` 实例生命周期/日志/PID 锁、`manager.js` 多房间调度与有序清理、`index.js` HTTP/SSE/静态托管）。
- 界面：`public/`（Canvas 地图与控件，内核驱动、失败反馈回显）。
- 模拟角色：`scripts/lib/bot.js`（仅通过 HTTP 指令行动，可复现随机种子）。
- 自检：`scripts/selftest/`（进程编排、双实例场景、界面链路）。
- 发布配置：`deploy/configs/`、`deploy/resources/`、`deploy/bin/`。
- 容器等价物：`Dockerfile`、`docker-compose.yml`。

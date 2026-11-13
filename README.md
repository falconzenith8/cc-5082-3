# 据点争夺（Capture Arena）

多阵营据点争夺的可操作地图 + 服务端权威规则引擎。占领进度完全由客户端发来的输入（移动、射击、换阵营、离场）与服务端每帧的资格计算驱动，不做任何定时播放的占领动画。

## 运行

```bash
npm start           # 单实例 http://127.0.0.1:8080（可用 PORT / HOST / STATE_DIR 覆盖）
npm test            # 引擎与 HTTP/SSE 接口测试（29 项）
```

零依赖，Node ≥ 20。打开页面后可新建多场对局，在同一页面切换；每场对局状态与事件流互相独立。

### 本地多对局运行包（双隔离实例）

```bash
npm run instances:start   # 启动 alpha(:18081) 与 beta(:18082)，独立状态目录 run/<instance>
npm run selftest          # 发布自检：双实例真实争夺、隔离性、故障注入、清理验证（11 项）
npm run ui-check          # 界面操作链路：移动→争夺→占领→计分→失败反馈→房间关闭
npm run instances:stop    # 有序关停，cleanup.json 证明房间/订阅/时钟全部结束
```

完整的重建步骤、可重复比赛 walkthrough、容量限制与故障诊断说明见 [`docs/deployment.md`](docs/deployment.md)。容器等价配置见 `Dockerfile` 与 `docker-compose.yml`。

操作方式：

1. 选阵营与角色 →「加入」；可「+ 演练单位」快速补足测试阵容。
2. 「开始」后，在地图上点击地面=移动，点击敌方角色=射击。
3. 右侧「操作角色」可切换操控任一实体；「换阵营」把当前角色派往所选阵营；「离场」释放其参与记录。
4. 「回放」载入当前对局的事件与关键帧，可播放/拖动时间轴。

## 规则模型

据点状态由三部分组成：**控制方 `owner`**、**挑战方 `challenger`**、**占领进度 `progress`（0→100）**。控制方存在时进度归零；挑战方推满 100 即易主，并把 25 分占领奖励记给新控制方。

每帧按参与记录重新计算「有效资格」，而不是把区域人数相减：

| 维度 | 含义 |
| --- | --- |
| 存活 `contest` | 存活且在据点内，计 1；阵亡立即释放参与记录 |
| 占领 `capture` | 存活 + 未被压制 + 角色有资格；权重 = 角色权重 |
| 角色权重 | 突击手 1、工兵 1.5、支援 0（支援只参与争夺、无占领资格） |

推进规律：

- **空场**：无人推进，`progress` 按 `decayRate` 回落到 0；计分节点跳过并记录 `owner_absent`/`unowned`。
- **单方**：`captureRate × 权重` 推进；若该方已是控制方，则反向修复进度（不改变控制权）。
- **多方**：领跑者需压过**其余所有阵营有效权重之和**，仅以净值 × `contestedFactor` 推进；净值 ≤ 0 进入 `deadlock`，进度回落。控制方在争夺中净值占优时以 `decayRate` 压下挑战进度。
- **固守计分**：每 `scoreIntervalMs` 在控制方**无挑战、无进度、有己方在场、无敌方存活在场**时 +`holdPointsPerSec`。跳过原因写入事件（`under_contest` / `contested_presence` / `owner_absent`）。

结算与身份：

- 分数按**比赛时间边界**结算：一次跨多个节点会按边界依次补算，每节点只结算一次。
- 达到 `scoreToWin` 立即结束，`awardScore` 之后拒绝任何旧回调；超时按 `durationMs` 边界结束。
- 阵亡、复活、换阵营都会推进 `generation`；携带旧 `generation` 的指令返回 409，参与记录按新身份重建。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 实例健康：ID、房间相位、缓冲/丢弃统计 |
| GET | `/api/stats` | 房间数、上限、订阅数与事件/关键帧容量统计 |
| GET/POST | `/api/matches` | 列出 / 新建对局（超 `maxRooms` 返回 409） |
| GET/DELETE | `/api/matches/:id` | 快照 / 按固定次序关闭房间并返回终态摘要 |
| GET | `/api/matches/:id/stream` | SSE：`hello`、增量事件、节流后的 `state` |
| GET | `/api/matches/:id/events?since=` | 增量事件 |
| GET | `/api/matches/:id/replay` | 元信息 + 事件 + 关键帧 |
| POST | `/api/matches/:id/players` | 加入（`faction`、`role`、`name`） |
| DELETE | `/api/matches/:id/players/:pid` | 离场并释放参与记录 |
| POST | `/api/matches/:id/players/:pid/faction` | 换阵营 |
| POST | `/api/matches/:id/players/:pid/command` | `move` / `stop` / `fire` |
| POST | `/api/matches/:id/start` / `end` | 开始 / 结束 |

快照同时给出 `presence`（参与记录与逐人 `status`/`captureWeight`）、`factions`（按阵营的存活/资格汇总）、`momentum`（推进类型、净值、速度、权重）与 `scores`。

## 结构

- `src/engine/`：`match.js` 状态机、`capture.js` 资格与动量、`presence.js` 参与记录、`events.js` 事件与关键帧（含容量上限与丢弃统计）。
- `src/server/`：`main.js` 进程入口、`runtime.js` 实例生命周期（PID 锁、日志轮转、关停报告）、`manager.js` 多对局调度、容量限制与有序清理、`index.js` HTTP/SSE/静态资源。
- `public/`：Canvas 地图、输入驱动、资格面板、事件流与回放播放器；内核拒绝的操作以通知条反馈，房间关闭通过 SSE 提示。
- `scripts/lib/bot.js`：仅走 HTTP 指令的模拟角色（可复现随机种子）。
- `scripts/selftest/`：双实例发布自检与界面操作链路自检。
- `deploy/`：双实例配置、示例房间模板、启动/停止脚本。
- `docs/deployment.md`：部署、完整比赛流程与故障诊断。

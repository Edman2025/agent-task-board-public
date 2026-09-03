# Agent Task Board (MVP)

一个用于展示所有 Agent 任务状态的实时看板（MVP）。

## 已完成（v1.0）

- 总览指标：总任务数、运行中、已完成、失败、阻塞
- Kanban 列：Backlog / Ready / Running / Blocked / Review / Done / Failed
- Agent 绩效表：每个 Agent 的任务量、成功率、平均耗时（分钟）
- 任务详情抽屉：基础信息 + 事件时间线
- 任务筛选：按 Agent / 状态 / 优先级 / 关键词搜索
- 超时告警：对 Running/Blocked/Review 任务按阈值预警
- SSE 实时刷新（默认每 5 秒推送快照）
- 状态更新 API：支持任务状态变更并记录事件
- 最小权限控制：`readonly` / `editor`（基于 `x-role` 请求头）
- PostgreSQL 数据源支持（`DATA_SOURCE=postgres`）
- Agent 事件接入 API（`/api/ingest/events`，支持幂等去重）
- 可选接入 Token（`INGEST_TOKEN` + `x-ingest-token`）
- 看板拖拽改状态（editor 角色）
- 审计日志（状态变更/接入事件）
- 告警规则配置化（running/blocked/review 可独立阈值）
- 连接器模板（OpenClaw/GitHub/Jira）
- SLA 报表（日/周，含平均耗时与P95）
- 多维汇总（按负责人）
- 连接器自动映射（`/api/ingest/mapped` + mapping 配置）
- Token 鉴权 + scope（read/write/config）
- 多视图汇总（assignee/agent/project）
- CSV 导出（tasks/summary/sla）
- 连接器健康监控（事件量、最近事件、延迟）
- 定时任务模块（展示 Agent 定时任务与执行状态）
- 告警推送配置（Webhook 开关）
- 后端 API（Node 原生 HTTP，无框架依赖）

## 目录结构

```bash
agent-task-board/
  ├── server.js            # API + 静态资源服务
  ├── data/sample-data.json
  ├── public/
  │   ├── index.html
  │   ├── app.js
  │   └── styles.css
  └── db/schema.sql        # PostgreSQL 建表 SQL（下一步落库）
```

## 启动方式

```bash
cd agent-task-board
npm install
node server.js
```

默认端口：`3000`

### 切换为 PostgreSQL

```bash
export DATA_SOURCE=postgres
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=postgres
export PGPASSWORD=your_password
export PGDATABASE=agent_task_board
node server.js
```

先执行：

```bash
psql -d agent_task_board -f db/schema.sql
```

如果你要“只显示真实接入数据”，不要执行 `db/seed.sql`。
若库里已经有历史 demo/seed 数据，可执行：

```bash
# 方式1：psql
psql -d agent_task_board -f db/clear.sql

# 方式2：Node（不依赖 psql）
npm run db:clear
```

打开：`http://localhost:3000`

## API（MVP）

- `GET /api/snapshot`（聚合返回 overview/tasks/agents/alerts）
- `GET /api/overview`
- `GET /api/tasks`
- `GET /api/agents`
- `GET /api/alerts`
- `GET /api/tasks/:taskId/events`
- `PATCH /api/tasks/:taskId/status`（需 `x-role: editor`）
- `POST /api/ingest/events`
- `POST /api/ingest/mapped`（connector + payload 自动映射）
- `GET /api/audit-logs`
- `GET /api/config/alerts`
- `PUT /api/config/alerts`（需 `config` scope）
- `GET /api/connectors/templates`
- `GET /api/config/mappings/:connector`
- `PUT /api/config/mappings/:connector`（需 `config` scope）
- `GET /api/reports/sla?period=daily|weekly`
- `GET /api/reports/summary?view=assignee|agent|project`
- `GET /api/reports/export.csv?type=tasks|summary|sla`
- `GET /api/connectors/health`
- `GET /api/cron-jobs`
- `GET|PUT /api/config/alert-channels`
- `POST /api/config/alert-channels/test`
- `GET /api/me`
- `GET /api/stream`（SSE 实时流）

筛选参数（可用于 `/api/snapshot`、`/api/tasks`、`/api/overview`、`/api/agents`、`/api/alerts`）：
- `agent`
- `status`
- `priority`
- `search`

### 接入事件示例

```bash
curl -X POST http://localhost:3000/api/ingest/events \
  -H 'content-type: application/json' \
  -d '{
    "source":"openclaw",
    "events":[
      {
        "id":"evt-1",
        "type":"task_created",
        "agent":{"id":"a9","name":"ops-agent","type":"ops","status":"online"},
        "task":{"id":"t-9001","title":"新任务","agent_id":"a9","priority":"high","status":"ready","assignee":"ops-agent"}
      },
      {
        "id":"evt-2",
        "type":"status_changed",
        "task_id":"t-9001",
        "to_status":"running",
        "actor":"ops-agent"
      }
    ]
  }'
```

生产部署时请按服务端配置添加 `x-ingest-token` 请求头，不要把真实 token 写入脚本或仓库。

## 下一步计划（v1.1）

1. Token 生命周期管理（吊销、过期、备注）
2. 导出能力补齐 PDF
3. 连接器失败率/重试监控
4. 告警通知渠道扩展（DingTalk/Telegram）

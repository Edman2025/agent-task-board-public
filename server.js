const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(__dirname, 'data', 'sample-data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATUS_COLUMNS = ['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'failed'];
const ALERT_THRESHOLD_MINUTES = Number(process.env.ALERT_THRESHOLD_MINUTES || 60);
const ALERT_RULES_PATH = path.join(__dirname, 'data', 'alert-rules.json');
const AUTH_TOKENS_PATH = path.join(__dirname, 'data', 'auth-tokens.json');
const CONNECTOR_MAPPINGS_PATH = path.join(__dirname, 'data', 'connector-mappings.json');
const ALERT_CHANNELS_PATH = path.join(__dirname, 'data', 'alert-channels.json');
const CRON_JOBS_PATH = path.join(__dirname, 'data', 'cron-jobs.json');
const DATA_SOURCE = process.env.DATA_SOURCE || 'file'; // file | postgres
const ROLE_HEADER = 'x-role'; // readonly | editor
const INGEST_TOKEN = process.env.INGEST_TOKEN || ''; // optional

const sseClients = new Set();

let pgPool = null;
if (DATA_SOURCE === 'postgres') {
  const { Pool } = require('pg');
  pgPool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'agent_task_board'
  });
}

function roleOf(req) {
  return (req.headers[ROLE_HEADER] || 'readonly').toLowerCase();
}

function canEdit(req) {
  return roleOf(req) === 'editor';
}

function loadAuthTokens() {
  if (!fs.existsSync(AUTH_TOKENS_PATH)) return { tokens: [] };
  return JSON.parse(fs.readFileSync(AUTH_TOKENS_PATH, 'utf8'));
}

function loadAlertChannels() {
  if (!fs.existsSync(ALERT_CHANNELS_PATH)) return { webhookUrl: '', enabled: false };
  return JSON.parse(fs.readFileSync(ALERT_CHANNELS_PATH, 'utf8'));
}

function saveAlertChannels(config) {
  fs.writeFileSync(ALERT_CHANNELS_PATH, JSON.stringify(config, null, 2), 'utf8');
}

async function loadCronJobs() {
  if (DATA_SOURCE !== 'postgres') {
    if (!fs.existsSync(CRON_JOBS_PATH)) return { jobs: [] };
    const raw = JSON.parse(fs.readFileSync(CRON_JOBS_PATH, 'utf8'));
    return { jobs: Array.isArray(raw?.jobs) ? raw.jobs : [] };
  }
  try {
    const res = await pgPool.query('SELECT agent_id, job_name, schedule, exec_url, next_run_at, last_run_at, last_status, success_count, fail_count FROM cron_jobs ORDER BY agent_id, job_name');
    return { jobs: res.rows.map(r => ({
      agentId: r.agent_id,
      jobName: r.job_name,
      schedule: r.schedule,
      execUrl: r.exec_url,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastStatus: r.last_status,
      successCount: r.success_count,
      failCount: r.fail_count
    }))};
  } catch (e) {
    console.log('[CRON] loadCronJobs error:', e.message);
    return { jobs: [] };
  }
}

function resolveAuth(req) {
  const headerToken = req.headers['x-api-token'] || '';
  const bearer = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  const token = headerToken || bearer;
  if (token) {
    const cfg = loadAuthTokens();
    const found = (cfg.tokens || []).find((t) => t.token === token);
    if (found) return { role: found.role || 'readonly', scopes: found.scopes || ['read'], tokenMatched: true };
  }
  return { role: roleOf(req), scopes: canEdit(req) ? ['read', 'write', 'config'] : ['read'], tokenMatched: false };
}

function requireScope(req, scope) {
  const auth = resolveAuth(req);
  return auth.scopes.includes(scope) || auth.scopes.includes('*');
}

function canIngest(req) {
  if (!INGEST_TOKEN) return true;
  return req.headers['x-ingest-token'] === INGEST_TOKEN;
}

function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const rawPath = req.url.split('?')[0];
  const safePath = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not Found');
  }

  const ext = path.extname(filePath);
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'text/plain; charset=utf-8';

  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

function filterTasks(tasks, query) {
  return tasks.filter((t) => {
    // Exclude cron/scheduled tasks from main board
    if (t.isCronJob) return false;
    if (query.agent && t.agent_id !== query.agent) return false;
    if (query.status && t.status !== query.status) return false;
    if (query.priority && t.priority !== query.priority) return false;
    if (query.search) {
      const q = query.search.toLowerCase();
      const hay = `${t.id} ${t.title} ${t.assignee}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function toDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeData(data) {
  return {
    agents: data.agents,
    tasks: data.tasks.map((t) => ({
      ...t,
      isCronJob: t.is_cron_job || t.isCronJob || false,
      created_at: toDateLike(t.created_at),
      started_at: toDateLike(t.started_at),
      finished_at: toDateLike(t.finished_at),
      due_at: toDateLike(t.due_at)
    })),
    events: data.events.map((e) => ({ ...e, created_at: toDateLike(e.created_at) })),
    auditLogs: (data.auditLogs || []).map((a) => ({ ...a, created_at: toDateLike(a.created_at) }))
  };
}

function loadAlertRules() {
  if (!fs.existsSync(ALERT_RULES_PATH)) {
    return {
      defaultMinutes: ALERT_THRESHOLD_MINUTES,
      statusMinutes: { running: ALERT_THRESHOLD_MINUTES, blocked: 30, review: 90 }
    };
  }
  return JSON.parse(fs.readFileSync(ALERT_RULES_PATH, 'utf8'));
}

function saveAlertRules(rules) {
  fs.writeFileSync(ALERT_RULES_PATH, JSON.stringify(rules, null, 2), 'utf8');
}

function loadConnectorMappings() {
  if (!fs.existsSync(CONNECTOR_MAPPINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(CONNECTOR_MAPPINGS_PATH, 'utf8'));
}

function saveConnectorMappings(mappings) {
  fs.writeFileSync(CONNECTOR_MAPPINGS_PATH, JSON.stringify(mappings, null, 2), 'utf8');
}

function getByPath(obj, dottedPath) {
  return String(dottedPath || '')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function mapInboundToEvents(connector, payload) {
  const mappings = loadConnectorMappings();
  const m = mappings[connector];
  if (!m) throw new Error(`connector mapping not found: ${connector}`);

  const taskId = String(getByPath({ payload }, m.taskIdPath) || '').trim();
  const title = String(getByPath({ payload }, m.titlePath) || taskId || 'untitled');
  const rawStatus = String(getByPath({ payload }, m.statusPath) || '').trim();
  const mappedStatus = m.statusMap?.[rawStatus] || 'ready';

  if (!taskId) throw new Error('task id not resolved from mapping');

  return [
    {
      id: `${connector}-${taskId}-upsert-${Date.now()}`,
      type: 'task_updated',
      agent: { id: m.agentId || `${connector}-connector`, name: m.agentName || `${connector} connector`, type: 'integration', status: 'online' },
      task: {
        id: taskId,
        title,
        agent_id: m.agentId || `${connector}-connector`,
        priority: 'medium',
        status: mappedStatus,
        assignee: m.agentId || `${connector}-connector`
      }
    }
  ];
}

async function loadData() {
  if (DATA_SOURCE === 'file') {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    data.auditLogs = data.auditLogs || [];
    return data;
  }

  const [agentsRes, tasksRes, eventsRes, auditRes] = await Promise.all([
    pgPool.query('select id, name, type, status from agents order by id'),
    pgPool.query('select id, title, agent_id, priority, status, created_at, started_at, finished_at, due_at, retry_count, assignee, is_cron_job from tasks order by created_at desc'),
    pgPool.query('select id, task_id, from_status, to_status, event_type, payload, created_at from task_events order by created_at desc'),
    pgPool.query('select id, action, actor, task_id, details, created_at from audit_logs order by created_at desc limit 200')
  ]);

  return normalizeData({
    agents: agentsRes.rows,
    tasks: tasksRes.rows,
    events: eventsRes.rows,
    auditLogs: auditRes.rows
  });
}

async function writeAuditLog(log) {
  const row = {
    id: log.id || `al-${crypto.randomUUID()}`,
    action: log.action || 'unknown',
    actor: log.actor || 'system',
    task_id: log.task_id || null,
    details: log.details || {},
    created_at: log.created_at || new Date().toISOString()
  };

  if (DATA_SOURCE === 'file') {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    data.auditLogs = data.auditLogs || [];
    data.auditLogs.unshift(row);
    data.auditLogs = data.auditLogs.slice(0, 500);
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
    return row;
  }

  await pgPool.query(
    'insert into audit_logs(id, action, actor, task_id, details, created_at) values($1,$2,$3,$4,$5,$6)',
    [row.id, row.action, row.actor, row.task_id, row.details, row.created_at]
  );
  return row;
}

function applyStatusRules(task, toStatus) {
  task.status = toStatus;
  if (toStatus === 'running' && !task.started_at) task.started_at = new Date().toISOString();
  if (toStatus === 'done' || toStatus === 'failed') task.finished_at = new Date().toISOString();
}

async function updateTaskStatus(taskId, toStatus, actor = 'system') {
  if (!STATUS_COLUMNS.includes(toStatus)) throw new Error('invalid status');

  if (DATA_SOURCE === 'file') {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const fromStatus = task.status;
    applyStatusRules(task, toStatus);

    data.events.unshift({
      id: `e-${Date.now()}`,
      task_id: taskId,
      from_status: fromStatus,
      to_status: toStatus,
      event_type: 'status_changed',
      payload: { actor },
      created_at: new Date().toISOString()
    });

    data.auditLogs = data.auditLogs || [];
    data.auditLogs.unshift({
      id: `al-${Date.now()}`,
      action: 'task_status_updated',
      actor,
      task_id: taskId,
      details: { from_status: fromStatus, to_status: toStatus },
      created_at: new Date().toISOString()
    });

    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
    return task;
  }

  const client = await pgPool.connect();
  try {
    await client.query('begin');
    const taskRes = await client.query('select * from tasks where id = $1 for update', [taskId]);
    if (taskRes.rowCount === 0) {
      await client.query('rollback');
      return null;
    }
    const task = taskRes.rows[0];
    const fromStatus = task.status;

    await client.query(
      `update tasks
       set status = $2,
           started_at = case when $2 = 'running' and started_at is null then now() else started_at end,
           finished_at = case when $2 in ('done','failed') then now() else finished_at end
       where id = $1`,
      [taskId, toStatus]
    );

    const eventId = `e-${crypto.randomUUID()}`;
    await client.query(
      'insert into task_events(id, task_id, from_status, to_status, event_type, payload, created_at) values($1,$2,$3,$4,$5,$6,now())',
      [eventId, taskId, fromStatus, toStatus, 'status_changed', { actor }]
    );

    await client.query(
      'insert into audit_logs(id, action, actor, task_id, details, created_at) values($1,$2,$3,$4,$5,now())',
      [`al-${crypto.randomUUID()}`, 'task_status_updated', actor, taskId, { from_status: fromStatus, to_status: toStatus }]
    );

    await client.query('commit');
    const updated = await client.query('select * from tasks where id = $1', [taskId]);
    return normalizeData({ agents: [], tasks: updated.rows, events: [], auditLogs: [] }).tasks[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

function ensureTaskShape(payload) {
  return {
    id: payload.id,
    title: payload.title || payload.id,
    agent_id: payload.agent_id,
    priority: payload.priority || 'medium',
    status: payload.status || 'backlog',
    assignee: payload.assignee || payload.agent_id,
    retry_count: Number(payload.retry_count || 0),
    created_at: payload.created_at || new Date().toISOString(),
    started_at: payload.started_at || null,
    finished_at: payload.finished_at || null,
    due_at: payload.due_at || null
  };
}

function ingestEventId(ev) {
  return ev.id || `ev-${crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex').slice(0, 16)}`;
}

async function ingestEvents(events, source = 'external') {
  if (!Array.isArray(events) || events.length === 0) return { processed: 0, skipped: 0 };

  if (DATA_SOURCE === 'file') {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    data.ingestDedup = data.ingestDedup || [];
    data.auditLogs = data.auditLogs || [];
    const seen = new Set(data.ingestDedup);

    let processed = 0;
    let skipped = 0;

    for (const ev of events) {
      const dedupKey = ingestEventId(ev);
      if (seen.has(dedupKey)) {
        skipped++;
        continue;
      }
      seen.add(dedupKey);
      processed++;

      if (ev.agent) {
        const a = ev.agent;
        const found = data.agents.find((x) => x.id === a.id);
        if (!found) data.agents.push({ id: a.id, name: a.name || a.id, type: a.type || 'execution', status: a.status || 'online' });
      }

      if (ev.type === 'task_created' || ev.type === 'task_updated') {
        const t = ensureTaskShape(ev.task || {});
        if (!t.id || !t.agent_id) continue;

        // Fallback registration: allow task payload alone to surface agent info.
        if (!data.agents.find((x) => x.id === t.agent_id)) {
          data.agents.push({
            id: t.agent_id,
            name: t.assignee || t.agent_id,
            type: 'unknown',
            status: 'unknown'
          });
        }

        const idx = data.tasks.findIndex((x) => x.id === t.id);
        if (idx >= 0) data.tasks[idx] = { ...data.tasks[idx], ...t };
        else data.tasks.unshift(t);
      }

      if (ev.type === 'status_changed') {
        const t = data.tasks.find((x) => x.id === ev.task_id);
        if (!t) continue;
        const fromStatus = t.status;
        const toStatus = ev.to_status;
        if (STATUS_COLUMNS.includes(toStatus)) applyStatusRules(t, toStatus);
        data.events.unshift({
          id: `e-${crypto.randomUUID()}`,
          task_id: ev.task_id,
          from_status: fromStatus,
          to_status: toStatus,
          event_type: 'status_changed',
          payload: { actor: ev.actor || source, source, dedupKey },
          created_at: ev.created_at || new Date().toISOString()
        });
      }

      data.auditLogs.unshift({
        id: `al-${crypto.randomUUID()}`,
        action: 'ingest_event',
        actor: source,
        task_id: ev.task_id || ev.task?.id || null,
        details: { dedupKey, type: ev.type },
        created_at: ev.created_at || new Date().toISOString()
      });
    }

    data.ingestDedup = Array.from(seen).slice(-5000);
    data.auditLogs = data.auditLogs.slice(0, 500);
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
    return { processed, skipped };
  }

  const client = await pgPool.connect();
  let processed = 0;
  let skipped = 0;
  try {
    await client.query('begin');

    for (const ev of events) {
      const dedupKey = ingestEventId(ev);
      const dedup = await client.query(
        'insert into ingest_dedup(event_id, source, payload) values($1,$2,$3) on conflict(event_id) do nothing returning event_id',
        [dedupKey, source, ev]
      );
      if (dedup.rowCount === 0) {
        skipped++;
        continue;
      }
      processed++;

      if (ev.agent) {
        const a = ev.agent;
        await client.query(
          `insert into agents(id, name, type, status)
           values($1,$2,$3,$4)
           on conflict(id) do update set name=excluded.name, type=excluded.type, status=excluded.status`,
          [a.id, a.name || a.id, a.type || 'execution', a.status || 'online']
        );
      }

      if (ev.type === 'task_created' || ev.type === 'task_updated') {
        const t = ensureTaskShape(ev.task || {});
        if (!t.id || !t.agent_id) continue;

        // Fallback registration: if event does not include ev.agent,
        // still keep agent discoverable from task payload.
        await client.query(
          `insert into agents(id, name, type, status)
           values($1,$2,$3,$4)
           on conflict(id) do nothing`,
          [t.agent_id, t.assignee || t.agent_id, 'unknown', 'unknown']
        );

        await client.query(
          `insert into tasks(id,title,agent_id,priority,status,assignee,created_at,started_at,finished_at,due_at,retry_count)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict(id) do update set
             title=excluded.title,
             agent_id=excluded.agent_id,
             priority=excluded.priority,
             status=excluded.status,
             assignee=excluded.assignee,
             started_at=coalesce(excluded.started_at,tasks.started_at),
             finished_at=coalesce(excluded.finished_at,tasks.finished_at),
             due_at=coalesce(excluded.due_at,tasks.due_at),
             retry_count=excluded.retry_count`,
          [t.id, t.title, t.agent_id, t.priority, t.status, t.assignee, t.created_at, t.started_at, t.finished_at, t.due_at, t.retry_count]
        );
      }

      if (ev.type === 'status_changed') {
        const taskRes = await client.query('select status from tasks where id=$1 for update', [ev.task_id]);
        if (taskRes.rowCount === 0) continue;
        const fromStatus = taskRes.rows[0].status;
        const toStatus = ev.to_status;
        if (!STATUS_COLUMNS.includes(toStatus)) continue;

        await client.query(
          `update tasks
           set status=$2,
               started_at=case when $2='running' and started_at is null then now() else started_at end,
               finished_at=case when $2 in ('done','failed') then now() else finished_at end
           where id=$1`,
          [ev.task_id, toStatus]
        );

        await client.query(
          'insert into task_events(id, task_id, from_status, to_status, event_type, payload, created_at) values($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()))',
          [`e-${crypto.randomUUID()}`, ev.task_id, fromStatus, toStatus, 'status_changed', { actor: ev.actor || source, source, dedupKey }, ev.created_at || null]
        );
      }

      await client.query(
        'insert into audit_logs(id, action, actor, task_id, details, created_at) values($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()))',
        [`al-${crypto.randomUUID()}`, 'ingest_event', source, ev.task_id || ev.task?.id || null, { dedupKey, type: ev.type }, ev.created_at || null]
      );
    }

    await client.query('commit');
    return { processed, skipped };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

function computeOverview(tasks) {
  const byStatus = STATUS_COLUMNS.reduce((acc, s) => ((acc[s] = 0), acc), {});
  tasks.forEach((t) => {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  });

  return {
    total: tasks.length,
    running: byStatus.running || 0,
    done: byStatus.done || 0,
    failed: byStatus.failed || 0,
    blocked: byStatus.blocked || 0,
    byStatus
  };
}

function computeAgentStats(tasks, agents) {
  const merged = new Map((agents || []).map((a) => [a.id, a]));

  // Fallback: some connectors may only send task payloads with agent_id,
  // ensure these agents are still visible in the board.
  for (const t of tasks || []) {
    if (!t.agent_id) continue;
    if (!merged.has(t.agent_id)) {
      merged.set(t.agent_id, {
        id: t.agent_id,
        name: t.assignee || t.agent_id,
        type: 'unknown',
        status: 'unknown'
      });
    }
  }

  return Array.from(merged.values()).map((agent) => {
    const t = tasks.filter((x) => x.agent_id === agent.id);
    const done = t.filter((x) => x.status === 'done').length;
    const failed = t.filter((x) => x.status === 'failed').length;
    const completed = t.filter((x) => x.finished_at && x.started_at);
    const avgMinutes = completed.length
      ? Math.round(
          completed.reduce((sum, x) => sum + (new Date(x.finished_at) - new Date(x.started_at)) / 60000, 0) /
            completed.length
        )
      : null;

    return {
      agent_id: agent.id,
      name: agent.name,
      type: agent.type,
      status: agent.status,
      taskCount: t.length,
      done,
      failed,
      successRate: t.length ? Math.round((done / t.length) * 100) : 0,
      avgMinutes
    };
  });
}

function computeAlerts(tasks, now = Date.now(), rules = loadAlertRules()) {
  const active = tasks.filter((t) => ['running', 'blocked', 'review'].includes(t.status));
  return active
    .map((t) => {
      const start = t.started_at || t.created_at;
      const ageMin = Math.floor((now - new Date(start).getTime()) / 60000);
      const threshold = Number(rules?.statusMinutes?.[t.status] ?? rules?.defaultMinutes ?? ALERT_THRESHOLD_MINUTES);
      return { ...t, ageMin, threshold };
    })
    .filter((t) => t.ageMin >= t.threshold)
    .sort((a, b) => b.ageMin - a.ageMin)
    .map((t) => ({
      task_id: t.id,
      title: t.title,
      status: t.status,
      assignee: t.assignee,
      ageMin: t.ageMin,
      threshold: t.threshold,
      severity: t.status === 'blocked' ? 'high' : 'medium'
    }));
}

function computeSLAReport(tasks, period = 'daily') {
  const buckets = {};
  const done = tasks.filter((t) => t.finished_at && t.started_at);

  for (const t of done) {
    const finished = new Date(t.finished_at);
    const key = period === 'weekly'
      ? `${finished.getUTCFullYear()}-W${Math.ceil((finished.getUTCDate() + 6 - finished.getUTCDay()) / 7)}`
      : finished.toISOString().slice(0, 10);

    const mins = (new Date(t.finished_at) - new Date(t.started_at)) / 60000;
    if (!buckets[key]) buckets[key] = { bucket: key, count: 0, totalMins: 0, p95Mins: 0, samples: [] };
    buckets[key].count += 1;
    buckets[key].totalMins += mins;
    buckets[key].samples.push(mins);
  }

  return Object.values(buckets)
    .map((b) => {
      const sorted = b.samples.sort((a, z) => a - z);
      const p95Index = Math.max(0, Math.floor(sorted.length * 0.95) - 1);
      return {
        bucket: b.bucket,
        completed: b.count,
        avgMins: Math.round(b.totalMins / b.count),
        p95Mins: Math.round(sorted[p95Index] || 0)
      };
    })
    .sort((a, z) => (a.bucket < z.bucket ? 1 : -1));
}

function computeDimensionSummary(tasks, view = 'assignee') {
  const bucket = {};
  const keyOf = (t) => {
    if (view === 'project') return t.project || 'default';
    if (view === 'agent') return t.agent_id || 'unknown';
    return t.assignee || t.agent_id || 'unknown';
  };

  for (const t of tasks) {
    const key = keyOf(t);
    if (!bucket[key]) bucket[key] = { name: key, total: 0, done: 0, failed: 0, running: 0 };
    bucket[key].total += 1;
    if (t.status === 'done') bucket[key].done += 1;
    if (t.status === 'failed') bucket[key].failed += 1;
    if (t.status === 'running') bucket[key].running += 1;
  }

  return {
    view,
    rows: Object.values(bucket).sort((a, z) => z.total - a.total)
  };
}

function toCSV(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(','));
  return lines.join('\n');
}

async function getSnapshot(query) {
  const data = await loadData();
  const tasks = filterTasks(data.tasks, query);
  const alertRules = loadAlertRules();
  return {
    generatedAt: new Date().toISOString(),
    overview: computeOverview(tasks),
    tasks,
    agents: computeAgentStats(tasks, data.agents),
    alerts: computeAlerts(tasks, Date.now(), alertRules),
    alertRules
  };
}

function sendSSE(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

let lastAlertDigest = '';

async function notifyAlertChannel(alerts) {
  const cfg = loadAlertChannels();
  if (!cfg.enabled || !cfg.webhookUrl) return;
  const top = alerts.slice(0, 3);
  const digest = JSON.stringify(top.map((a) => [a.task_id, a.status, a.ageMin]));
  if (!top.length || digest === lastAlertDigest) return;
  lastAlertDigest = digest;

  try {
    await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `Agent看板告警 ${top.length} 条`,
        alerts: top
      })
    });
  } catch (_) {}
}

async function broadcastSnapshot() {
  const payload = await getSnapshot({});
  for (const res of sseClients) sendSSE(res, 'snapshot', payload);
  await notifyAlertChannel(payload.alerts || []);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache'
    });
    res.write('\n');
    sseClients.add(res);
    sendSSE(res, 'snapshot', await getSnapshot({}));
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      const query = {
        agent: url.searchParams.get('agent') || '',
        status: url.searchParams.get('status') || '',
        priority: url.searchParams.get('priority') || '',
        search: url.searchParams.get('search') || ''
      };

      if (url.pathname === '/api/ingest/events' && req.method === 'POST') {
        if (!canIngest(req)) return sendJson(res, { error: 'forbidden: bad ingest token' }, 403);
        if (!requireScope(req, 'write')) return sendJson(res, { error: 'forbidden: write scope required' }, 403);
        const body = await parseBody(req);
        const result = await ingestEvents(body.events || [], body.source || 'external');
        await broadcastSnapshot();
        return sendJson(res, { ok: true, ...result });
      }

      if (url.pathname === '/api/ingest/mapped' && req.method === 'POST') {
        if (!canIngest(req)) return sendJson(res, { error: 'forbidden: bad ingest token' }, 403);
        if (!requireScope(req, 'write')) return sendJson(res, { error: 'forbidden: write scope required' }, 403);
        const body = await parseBody(req);
        const events = mapInboundToEvents(body.connector, body.payload || {});
        const result = await ingestEvents(events, body.connector || 'mapped');
        await broadcastSnapshot();
        return sendJson(res, { ok: true, mapped: true, ...result, events });
      }

      if (url.pathname === '/api/audit-logs' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
        const data = await loadData();
        return sendJson(res, (data.auditLogs || []).slice(0, limit));
      }

      if (url.pathname === '/api/config/alerts' && req.method === 'GET') {
        return sendJson(res, loadAlertRules());
      }

      if (url.pathname === '/api/config/alert-channels' && req.method === 'GET') {
        if (!requireScope(req, 'write') && !requireScope(req, 'config')) return sendJson(res, { error: 'forbidden: write/config scope required' }, 403);
        return sendJson(res, loadAlertChannels());
      }

      if (url.pathname === '/api/config/alert-channels' && req.method === 'PUT') {
        if (!requireScope(req, 'write') && !requireScope(req, 'config')) return sendJson(res, { error: 'forbidden: write/config scope required' }, 403);
        const body = await parseBody(req);
        const cfg = { webhookUrl: body.webhookUrl || '', enabled: !!body.enabled };
        saveAlertChannels(cfg);
        await writeAuditLog({ action: 'alert_channel_updated', actor: body.actor || resolveAuth(req).role, details: { enabled: cfg.enabled } });
        return sendJson(res, { ok: true, config: cfg });
      }

      if (url.pathname === '/api/config/alert-channels/test' && req.method === 'POST') {
        if (!requireScope(req, 'write') && !requireScope(req, 'config')) return sendJson(res, { error: 'forbidden: write/config scope required' }, 403);
        const body = await parseBody(req);
        const webhookUrl = String(body.webhookUrl || '').trim();
        if (!webhookUrl) return sendJson(res, { error: 'webhookUrl is required' }, 400);

        let u;
        try {
          u = new URL(webhookUrl);
        } catch {
          return sendJson(res, { error: 'invalid webhookUrl' }, 400);
        }
        if (!['http:', 'https:'].includes(u.protocol)) return sendJson(res, { error: 'invalid webhookUrl protocol' }, 400);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              msgtype: 'text',
              text: { content: `[ATB测试消息] ${new Date().toISOString()}` }
            }),
            signal: controller.signal
          });
          clearTimeout(timeout);
          await writeAuditLog({ action: 'alert_channel_tested', actor: body.actor || resolveAuth(req).role, details: { status: resp.status } });
          return sendJson(res, { ok: resp.ok, status: resp.status });
        } catch (e) {
          clearTimeout(timeout);
          return sendJson(res, { error: `webhook test failed: ${e.message || e}` }, 502);
        }
      }

      if (url.pathname === '/api/config/alerts' && req.method === 'PUT') {
        if (!requireScope(req, 'config')) return sendJson(res, { error: 'forbidden: config scope required' }, 403);
        const body = await parseBody(req);
        const nextRules = {
          defaultMinutes: Number(body.defaultMinutes || ALERT_THRESHOLD_MINUTES),
          statusMinutes: {
            running: Number(body?.statusMinutes?.running || body.defaultMinutes || ALERT_THRESHOLD_MINUTES),
            blocked: Number(body?.statusMinutes?.blocked || 30),
            review: Number(body?.statusMinutes?.review || 90)
          }
        };
        saveAlertRules(nextRules);
        await writeAuditLog({ action: 'alert_rules_updated', actor: body.actor || roleOf(req), details: nextRules });
        await broadcastSnapshot();
        return sendJson(res, { ok: true, rules: nextRules });
      }

      if (url.pathname === '/api/connectors/templates' && req.method === 'GET') {
        return sendJson(res, {
          connectors: [
            { id: 'openclaw', name: 'OpenClaw', method: 'POST', path: '/api/ingest/events', notes: 'push task_created/task_updated/status_changed events' },
            { id: 'github', name: 'GitHub', method: 'webhook->transform->POST', path: '/api/ingest/events or /api/ingest/mapped', notes: 'map issue/pr/workflow events to board tasks' },
            { id: 'jira', name: 'Jira', method: 'webhook->transform->POST', path: '/api/ingest/events or /api/ingest/mapped', notes: 'map issue transitions to task status changes' }
          ]
        });
      }

      const mappingMatch = url.pathname.match(/^\/api\/config\/mappings\/([^/]+)$/);
      if (mappingMatch && req.method === 'GET') {
        const connector = mappingMatch[1];
        const all = loadConnectorMappings();
        return sendJson(res, { connector, mapping: all[connector] || null });
      }
      if (mappingMatch && req.method === 'PUT') {
        if (!requireScope(req, 'config')) return sendJson(res, { error: 'forbidden: config scope required' }, 403);
        const connector = mappingMatch[1];
        const body = await parseBody(req);
        const all = loadConnectorMappings();
        all[connector] = body;
        saveConnectorMappings(all);
        await writeAuditLog({ action: 'connector_mapping_updated', actor: body.actor || resolveAuth(req).role, details: { connector } });
        return sendJson(res, { ok: true, connector, mapping: all[connector] });
      }

      if (url.pathname === '/api/reports/sla' && req.method === 'GET') {
        const data = await loadData();
        const period = (url.searchParams.get('period') || 'daily').toLowerCase();
        return sendJson(res, {
          period,
          rows: computeSLAReport(data.tasks, period === 'weekly' ? 'weekly' : 'daily')
        });
      }

      if (url.pathname === '/api/reports/summary' && req.method === 'GET') {
        const data = await loadData();
        const view = (url.searchParams.get('view') || 'assignee').toLowerCase();
        return sendJson(res, computeDimensionSummary(data.tasks, view));
      }

      if (url.pathname === '/api/reports/export.csv' && req.method === 'GET') {
        const data = await loadData();
        const type = (url.searchParams.get('type') || 'tasks').toLowerCase();
        let csv = '';
        if (type === 'sla') {
          const period = (url.searchParams.get('period') || 'daily').toLowerCase();
          const rows = computeSLAReport(data.tasks, period === 'weekly' ? 'weekly' : 'daily');
          csv = toCSV(rows, ['bucket', 'completed', 'avgMins', 'p95Mins']);
        } else if (type === 'summary') {
          const view = (url.searchParams.get('view') || 'assignee').toLowerCase();
          const rows = computeDimensionSummary(data.tasks, view).rows;
          csv = toCSV(rows, ['name', 'total', 'done', 'failed', 'running']);
        } else {
          csv = toCSV(data.tasks, ['id', 'title', 'agent_id', 'assignee', 'priority', 'status', 'created_at', 'started_at', 'finished_at']);
        }

        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${type}-report.csv"`
        });
        return res.end(csv);
      }

      if (url.pathname === '/api/connectors/health' && req.method === 'GET') {
        const data = await loadData();
        const now = Date.now();
        const rows = (data.auditLogs || [])
          .filter((x) => x.action === 'ingest_event')
          .reduce((acc, x) => {
            const key = x.actor || 'unknown';
            if (!acc[key]) acc[key] = { connector: key, events: 0, lastEventAt: null, lagMinutes: null };
            acc[key].events += 1;
            if (!acc[key].lastEventAt || new Date(x.created_at) > new Date(acc[key].lastEventAt)) {
              acc[key].lastEventAt = x.created_at;
            }
            return acc;
          }, {});

        const health = Object.values(rows).map((r) => ({
          ...r,
          lagMinutes: r.lastEventAt ? Math.floor((now - new Date(r.lastEventAt).getTime()) / 60000) : null,
          status: r.lastEventAt && Math.floor((now - new Date(r.lastEventAt).getTime()) / 60000) <= 30 ? 'healthy' : 'stale'
        }));

        return sendJson(res, { rows: health.sort((a, z) => z.events - a.events) });
      }

      if (url.pathname === '/api/cron-jobs' && req.method === 'GET') {
        const cron = loadCronJobs();
        return sendJson(res, cron);
      }

      if (url.pathname === '/api/cron-jobs' && (req.method === 'POST' || req.method === 'PUT')) {
        if (!requireScope(req, 'write')) return sendJson(res, { error: 'forbidden: write scope required' }, 403);
        const body = await parseBody(req);
        const { agentId, jobName, schedule, nextRunAt, lastRunAt, lastStatus, successCount, failCount, execUrl } = body;
        if (!agentId || !jobName) return sendJson(res, { error: 'agentId and jobName are required' }, 400);

        const cron = loadCronJobs();
        const existingIdx = cron.jobs.findIndex(j => j.agentId === agentId && j.jobName === jobName);
        const job = {
          agentId,
          jobName,
          schedule: schedule || '*/10 * * * *',
          nextRunAt: nextRunAt || null,
          lastRunAt: lastRunAt || null,
          lastStatus: lastStatus || 'idle',
          successCount: successCount || 0,
          failCount: failCount || 0,
          execUrl: execUrl || null
        };

        if (existingIdx >= 0) {
          cron.jobs[existingIdx] = { ...cron.jobs[existingIdx], ...job };
        } else {
          cron.jobs.push(job);
        }

        fs.writeFileSync(CRON_JOBS_PATH, JSON.stringify(cron, null, 2));
        return sendJson(res, { ok: true, job });
      }

      const statusUpdateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
      if (statusUpdateMatch && req.method === 'PATCH') {
        if (!requireScope(req, 'write')) return sendJson(res, { error: 'forbidden: write scope required' }, 403);
        const body = await parseBody(req);
        if (!body.to_status) return sendJson(res, { error: 'to_status is required' }, 400);

        const updated = await updateTaskStatus(statusUpdateMatch[1], body.to_status, body.actor || 'editor');
        if (!updated) return sendJson(res, { error: 'task not found' }, 404);
        await broadcastSnapshot();
        return sendJson(res, { ok: true, task: updated });
      }

      const data = await loadData();
      const tasks = filterTasks(data.tasks, query);

      if (url.pathname === '/api/snapshot') return sendJson(res, await getSnapshot(query));
      if (url.pathname === '/api/overview') return sendJson(res, computeOverview(tasks));
      if (url.pathname === '/api/tasks') return sendJson(res, tasks);
      if (url.pathname === '/api/agents') return sendJson(res, computeAgentStats(tasks, data.agents));
      if (url.pathname === '/api/alerts') return sendJson(res, computeAlerts(tasks, Date.now(), loadAlertRules()));
      if (url.pathname === '/api/me') {
        const auth = resolveAuth(req);
        return sendJson(res, {
          role: auth.role,
          scopes: auth.scopes,
          editable: auth.scopes.includes('write') || auth.scopes.includes('*'),
          tokenMatched: auth.tokenMatched,
          dataSource: DATA_SOURCE
        });
      }

      const taskEventsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
      if (taskEventsMatch) return sendJson(res, data.events.filter((e) => e.task_id === taskEventsMatch[1]));

      return sendJson(res, { error: 'Not Found' }, 404);
    } catch (error) {
      return sendJson(res, { error: String(error.message || error) }, 500);
    }
  }

  return serveStatic(req, res);
});

setInterval(() => {
  if (sseClients.size > 0) broadcastSnapshot().catch(() => {});
}, 5000);

// Cron job scheduler
const scheduledTasks = new Map();

function loadCronJobs() {
  if (!fs.existsSync(CRON_JOBS_PATH)) return { jobs: [] };
  const raw = JSON.parse(fs.readFileSync(CRON_JOBS_PATH, 'utf8'));
  return { jobs: Array.isArray(raw?.jobs) ? raw.jobs : [] };
}

async function saveCronJobs(cronData) {
  if (DATA_SOURCE !== 'postgres') {
    fs.writeFileSync(CRON_JOBS_PATH, JSON.stringify(cronData, null, 2));
    return;
  }
  for (const job of cronData.jobs) {
    await pgPool.query(`
      INSERT INTO cron_jobs (agent_id, job_name, schedule, exec_url, next_run_at, last_run_at, last_status, success_count, fail_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (agent_id, job_name) DO UPDATE SET
        schedule = EXCLUDED.schedule,
        exec_url = EXCLUDED.exec_url,
        next_run_at = EXCLUDED.next_run_at,
        last_run_at = EXCLUDED.last_run_at,
        last_status = EXCLUDED.last_status,
        success_count = EXCLUDED.success_count,
        fail_count = EXCLUDED.fail_count,
        updated_at = now()
    `, [job.agentId, job.jobName, job.schedule, job.execUrl, job.nextRunAt, job.lastRunAt, job.lastStatus, job.successCount, job.failCount]);
  }
}

function calculateNextRunAt(schedule) {
  if (!schedule) return null;
  const now = new Date();
  const parts = schedule.split(' ');
  if (parts.length < 5) return null;

  const [min, hour, dom, mon, dow] = parts;
  const next = new Date(now);

  // Simple calculation for */n patterns
  if (min.startsWith('*/')) {
    const interval = parseInt(min.slice(2));
    const currentMin = next.getMinutes();
    const nextMin = Math.ceil((currentMin + 1) / interval) * interval;
    next.setMinutes(nextMin);
    next.setSeconds(0);
    if (next <= now) {
      next.setMinutes(next.getMinutes() + interval);
    }
  } else if (min === '*') {
    next.setSeconds(0);
    next.setMinutes(next.getMinutes() + 1);
  } else {
    next.setMinutes(parseInt(min));
    next.setSeconds(0);
    if (next <= now) {
      next.setHours(next.getHours() + 1);
    }
  }

  return next.toISOString();
}

function scheduleCronJob(job) {
  if (!job.schedule || !cron.validate(job.schedule)) {
    console.log(`Invalid schedule for ${job.agentId}/${job.jobName}: ${job.schedule}`);
    return;
  }

  // Calculate and update nextRunAt
  job.nextRunAt = calculateNextRunAt(job.schedule);
  const cronData = loadCronJobs();
  const idx = cronData.jobs.findIndex(j => j.agentId === job.agentId && j.jobName === job.jobName);
  if (idx >= 0) {
    cronData.jobs[idx].nextRunAt = job.nextRunAt;
    saveCronJobs(cronData);
  }

  // Cancel existing if any
  if (scheduledTasks.has(job.agentId + '/' + job.jobName)) {
    scheduledTasks.get(job.agentId + '/' + job.jobName).stop();
  }

  const task = cron.schedule(job.schedule, async () => {
    console.log(`[CRON] Executing ${job.agentId}/${job.jobName} at ${new Date().toISOString()}`);
    const now = new Date().toISOString();

    // Update job status to running
    const cronData = loadCronJobs();
    const idx = cronData.jobs.findIndex(j => j.agentId === job.agentId && j.jobName === job.jobName);
    let execSuccess = true;
    if (idx >= 0) {
      cronData.jobs[idx].lastRunAt = now;
      cronData.jobs[idx].lastStatus = 'running';
      cronData.jobs[idx].nextRunAt = calculateNextRunAt(cronData.jobs[idx].schedule);
      cronData.jobs[idx].successCount = (cronData.jobs[idx].successCount || 0);
      cronData.jobs[idx].failCount = (cronData.jobs[idx].failCount || 0);

      // Execute external URL if defined
      if (cronData.jobs[idx].execUrl) {
        try {
          const execRes = await fetch(cronData.jobs[idx].execUrl, { method: 'POST' });
          if (!execRes.ok) {
            console.log(`[CRON] execUrl failed for ${job.agentId}/${job.jobName}: HTTP ${execRes.status}`);
            execSuccess = false;
          } else {
            console.log(`[CRON] execUrl success for ${job.agentId}/${job.jobName}`);
          }
        } catch (e) {
          console.log(`[CRON] execUrl error for ${job.agentId}/${job.jobName}: ${e.message}`);
          execSuccess = false;
        }
      }

      // Update final status based on exec result
      cronData.jobs[idx].lastStatus = execSuccess ? 'success' : 'failed';
      if (execSuccess) {
        cronData.jobs[idx].successCount++;
      } else {
        cronData.jobs[idx].failCount++;
      }

      saveCronJobs(cronData);
      broadcastSnapshot();
    }

    // Broadcast to SSE clients
    broadcastSnapshot();
  });

  scheduledTasks.set(job.agentId + '/' + job.jobName, task);
  console.log(`[CRON] Scheduled ${job.agentId}/${job.jobName} with schedule: ${job.schedule}`);
}

function initCronScheduler() {
  let { jobs } = loadCronJobs();
  console.log(`[CRON] Initializing scheduler with ${jobs.length} jobs`);

  // Recalculate nextRunAt for all jobs on startup
  const now = new Date();
  jobs = jobs.map(job => {
    job.nextRunAt = calculateNextRunAt(job.schedule);
    return job;
  });

  // Save updated nextRunAt times
  saveCronJobs({ jobs });

  jobs.forEach(scheduleCronJob);
  console.log(`[CRON] All nextRunAt times recalculated`);
}

// Initialize cron scheduler
initCronScheduler();

server.listen(PORT, () => {
  console.log(`Agent Task Board running at http://localhost:${PORT} (source=${DATA_SOURCE})`);
});

const STATUS_COLUMNS = ['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'failed'];
const KANBAN_COLUMNS = [
  { key: 'ready', label: '待执行', statuses: ['ready'] },
  { key: 'running', label: '进行中', statuses: ['running'] },
  { key: 'review', label: '审查', statuses: ['review'] },
  { key: 'done', label: '结束', statuses: ['done'] },
  { key: 'other', label: '其他', statuses: ['backlog', 'blocked', 'failed'], dropStatus: 'backlog' }
];
let latestTasks = [];
let me = { role: 'editor', editable: true, scopes: ['read', 'write', 'config'] };
let draggingTaskId = null;
const KANBAN_PAGE_SIZE = 5;
const AUDIT_PAGE_SIZE = 10;
let kanbanPageByColumn = {};
let auditPage = 1;

function hasScope(scope) {
  return Array.isArray(me.scopes) && (me.scopes.includes(scope) || me.scopes.includes('*'));
}

function canConfig() {
  return hasScope('config');
}

function canAlertChannelEdit() {
  return hasScope('write') || hasScope('config');
}

function showAlertChannelMessage(text, type = '') {
  const el = document.getElementById('alert-channel-message');
  if (!el) return;
  el.textContent = text || '';
  el.className = `inline-message ${type}`.trim();
}

async function fetchJSON(url, options = {}) {
  const headers = {
    'x-role': me?.role || 'editor',
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `http ${res.status}`);
  }
  return res.json();
}

function renderSessionInfo() {
  const el = document.getElementById('session-info');
  el.innerHTML = `当前角色：${me.role}${me.editable ? '（可编辑，支持拖拽改状态）' : '（只读）'} · 数据源：${me.dataSource || 'file'} <button id="btn-open-settings">设置</button>`;
}

function renderAlertRules(rules) {
  document.getElementById('rule-running').value = rules?.statusMinutes?.running ?? '';
  document.getElementById('rule-blocked').value = rules?.statusMinutes?.blocked ?? '';
  document.getElementById('rule-review').value = rules?.statusMinutes?.review ?? '';
  const btn = document.getElementById('btn-save-rules');
  btn.style.display = canConfig() ? 'inline-block' : 'none';
}

function renderAlertChannel(cfg) {
  document.getElementById('alert-webhook').value = cfg?.webhookUrl || '';
  document.getElementById('alert-enabled').checked = !!cfg?.enabled;

  // Keep inputs and button interactive; enforce permission at save-time with explicit feedback.
}

function renderMetrics(overview) {
  const el = document.getElementById('metrics');
  const other = (overview?.byStatus?.backlog || 0) + (overview?.byStatus?.blocked || 0) + (overview?.byStatus?.failed || 0) + (overview?.byStatus?.review || 0);
  const items = [
    ['总任务', overview.total],
    ['待执行', overview?.byStatus?.ready || 0],
    ['进行中', overview.running],
    ['已完成', overview.done],
    ['其他', other]
  ];

  el.innerHTML = items
    .map(
      ([label, value]) => `
      <div class="metric-card">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </div>`
    )
    .join('');
}

function renderAlerts(alerts) {
  const el = document.getElementById('alerts');
  if (!alerts.length) {
    el.innerHTML = '<div class="alert ok">✅ 当前无超时告警</div>';
    return;
  }

  el.innerHTML = alerts
    .slice(0, 5)
    .map((a) => `<div class="alert ${a.severity}">⚠️ ${a.title}（${a.status}）已停留 ${a.ageMin} 分钟 · ${a.assignee}</div>`)
    .join('');
}

function taskCard(task, index) {
  const badging = task.status === 'blocked' || task.status === 'failed' ? 'danger' : '';
  const num = index !== undefined ? `${index + 1}. ` : '';
  return `
    <div class="task-card ${badging}" data-task-id="${task.id}" draggable="${me.editable}">
      <div><strong>${num}${task.title}</strong></div>
      <div class="task-meta">#${task.id} · ${task.assignee}</div>
      <div class="task-meta">优先级: ${task.priority} · 重试: ${task.retry_count}</div>
    </div>
  `;
}

function bindDnD(root) {
  if (!me.editable) return;

  root.querySelectorAll('.task-card').forEach((card) => {
    card.addEventListener('dragstart', () => {
      draggingTaskId = card.dataset.taskId;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      draggingTaskId = null;
      card.classList.remove('dragging');
      root.querySelectorAll('.column').forEach((c) => c.classList.remove('drop-active'));
    });
  });

  root.querySelectorAll('.column').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drop-active');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop-active'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop-active');
      if (!draggingTaskId) return;
      const toStatus = col.dataset.status;
      const current = latestTasks.find((t) => t.id === draggingTaskId);
      if (!current || current.status === toStatus) return;
      try {
        await patchStatus(draggingTaskId, toStatus);
      } catch (err) {
        alert(`拖拽更新失败：${err.message}`);
      }
    });
  });
}

function renderKanban(tasks) {
  const root = document.getElementById('kanban');
  // Sort tasks by created_at ascending for numbering (oldest = 1)
  const sortedTasks = [...tasks].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const taskIndexMap = new Map(sortedTasks.map((t, i) => [t.id, i + 1]));
  let globalIndex = 0;
  root.innerHTML = KANBAN_COLUMNS.map((col) => {
    const list = tasks.filter((t) => col.statuses.includes(t.status));
    const dropStatus = col.dropStatus || col.key;
    const totalPages = Math.max(1, Math.ceil(list.length / KANBAN_PAGE_SIZE));
    const page = Math.min(kanbanPageByColumn[col.key] || 1, totalPages);
    kanbanPageByColumn[col.key] = page;
    const pageItems = list.slice((page - 1) * KANBAN_PAGE_SIZE, page * KANBAN_PAGE_SIZE);

    return `
      <div class="column" data-status="${dropStatus}">
        <h3>${col.label} (${list.length})</h3>
        ${pageItems.map((t) => taskCard(t, taskIndexMap.get(t.id) - 1)).join('') || '<div class="task-meta">空</div>'}
        ${list.length > KANBAN_PAGE_SIZE ? `<div class="pager" data-col-key="${col.key}"><button data-page-act="prev">上一页</button><span>${page}/${totalPages}</span><button data-page-act="next">下一页</button></div>` : ''}
      </div>
    `;
  }).join('');

  root.querySelectorAll('.pager[data-col-key]').forEach((pager) => {
    const key = pager.dataset.colKey;
    pager.querySelector('[data-page-act="prev"]').addEventListener('click', () => {
      kanbanPageByColumn[key] = Math.max(1, (kanbanPageByColumn[key] || 1) - 1);
      renderKanban(latestTasks);
    });
    pager.querySelector('[data-page-act="next"]').addEventListener('click', () => {
      const col = KANBAN_COLUMNS.find((x) => x.key === key);
      const list = latestTasks.filter((t) => col.statuses.includes(t.status));
      const totalPages = Math.max(1, Math.ceil(list.length / KANBAN_PAGE_SIZE));
      kanbanPageByColumn[key] = Math.min(totalPages, (kanbanPageByColumn[key] || 1) + 1);
      renderKanban(latestTasks);
    });
  });

  root.querySelectorAll('.task-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const taskId = card.dataset.taskId;
      const task = latestTasks.find((t) => t.id === taskId);
      const events = await fetchJSON(`/api/tasks/${taskId}/events`);
      openDrawer(task, events);
    });
  });

  bindDnD(root);
}

function renderAgentTable(agentStats) {
  const tbody = document.querySelector('#agents-table tbody');
  tbody.innerHTML = agentStats
    .map(
      (a) => `
      <tr>
        <td>${a.name}</td>
        <td>${a.type}</td>
        <td>${a.status}</td>
        <td>${a.taskCount}</td>
        <td>${a.done}</td>
        <td>${a.failed}</td>
        <td>${a.successRate}%</td>
        <td>${a.avgMinutes ?? '-'}</td>
      </tr>
    `
    )
    .join('');
}


function renderCronJobs(rows) {
  const tbody = document.querySelector('#cron-jobs-table tbody');
  tbody.innerHTML = (rows || [])
    .map(
      (r) => `<tr>
        <td>${r.agentId}</td>
        <td>${r.jobName}</td>
        <td>${r.schedule}</td>
        <td>${r.execUrl ? '<code>' + r.execUrl + '</code>' : '-'}</td>
        <td>${r.nextRunAt ? new Date(r.nextRunAt).toLocaleString() : '-'}</td>
        <td>${r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : '-'}</td>
        <td>${r.lastStatus || '-'}</td>
        <td>${r.successCount ?? 0}</td>
        <td>${r.failCount ?? 0}</td>
      </tr>`
    )
    .join('');
}

function renderConnectorHealth(rows) {
  const tbody = document.querySelector('#connector-health-table tbody');
  tbody.innerHTML = (rows || [])
    .map(
      (r) => `<tr>
        <td>${r.connector}</td>
        <td>${r.events}</td>
        <td>${r.lastEventAt ? new Date(r.lastEventAt).toLocaleString() : '-'}</td>
        <td>${r.lagMinutes ?? '-'}</td>
        <td>${r.status}</td>
      </tr>`
    )
    .join('');
}

function renderAuditTable(logs) {
  const tbody = document.querySelector('#audit-table tbody');
  const pager = document.getElementById('audit-pagination');
  const totalPages = Math.max(1, Math.ceil((logs || []).length / AUDIT_PAGE_SIZE));
  auditPage = Math.min(auditPage, totalPages);
  const pageRows = (logs || []).slice((auditPage - 1) * AUDIT_PAGE_SIZE, auditPage * AUDIT_PAGE_SIZE);

  tbody.innerHTML = pageRows
    .map(
      (x) => `<tr>
        <td>${new Date(x.created_at).toLocaleString()}</td>
        <td>${x.action}</td>
        <td>${x.actor || '-'}</td>
        <td>${x.task_id || '-'}</td>
        <td><code>${JSON.stringify(x.details || {})}</code></td>
      </tr>`
    )
    .join('');

  pager.innerHTML = (logs || []).length > AUDIT_PAGE_SIZE
    ? `<button id="audit-prev">上一页</button><span>${auditPage}/${totalPages}</span><button id="audit-next">下一页</button>`
    : '';

  if ((logs || []).length > AUDIT_PAGE_SIZE) {
    document.getElementById('audit-prev').onclick = () => {
      auditPage = Math.max(1, auditPage - 1);
      renderAuditTable(logs || []);
    };
    document.getElementById('audit-next').onclick = () => {
      auditPage = Math.min(totalPages, auditPage + 1);
      renderAuditTable(logs || []);
    };
  }
}

async function patchStatus(taskId, toStatus) {
  await fetchJSON(`/api/tasks/${taskId}/status`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-role': me.role
    },
    body: JSON.stringify({ to_status: toStatus, actor: 'dashboard' })
  });
  await refresh();
  const events = await fetchJSON(`/api/tasks/${taskId}/events`);
  const task = latestTasks.find((t) => t.id === taskId);
  if (task) openDrawer(task, events);
}

function openDrawer(task, events) {
  const drawer = document.getElementById('drawer');
  drawer.classList.remove('hidden');

  const actions = me.editable
    ? `<h4>变更状态</h4>
       <div class="status-actions">
         ${STATUS_COLUMNS.map((s) => `<button data-status="${s}">${s}</button>`).join('')}
       </div>`
    : '<p class="task-meta">只读模式：不可变更状态</p>';

  drawer.innerHTML = `
    <div class="close-btn" id="close-drawer">关闭 ✕</div>
    <h3>${task.title}</h3>
    <p><strong>ID:</strong> ${task.id}</p>
    <p><strong>Agent:</strong> ${task.assignee}</p>
    <p><strong>状态:</strong> ${task.status}</p>
    <p><strong>优先级:</strong> ${task.priority}</p>
    ${actions}
    <h4>事件时间线</h4>
    <ul>
      ${events
        .map((e) => `<li>${new Date(e.created_at).toLocaleString()} · ${e.from_status || '-'} → ${e.to_status || '-'} (${e.event_type})</li>`)
        .join('') || '<li>暂无事件</li>'}
    </ul>
  `;

  document.getElementById('close-drawer').addEventListener('click', () => drawer.classList.add('hidden'));

  drawer.querySelectorAll('button[data-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await patchStatus(task.id, btn.dataset.status);
      } catch (e) {
        alert(`更新失败：${e.message}`);
      }
    });
  });
}

function bindAlertRuleActions() {
  document.getElementById('btn-save-rules').addEventListener('click', async () => {
    if (!canConfig()) return alert('当前账号无配置权限（缺少 config scope）');
    try {
      const running = Number(document.getElementById('rule-running').value || 60);
      const blocked = Number(document.getElementById('rule-blocked').value || 30);
      const review = Number(document.getElementById('rule-review').value || 90);
      await fetchJSON('/api/config/alerts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-role': me.role },
        body: JSON.stringify({
          defaultMinutes: running,
          statusMinutes: { running, blocked, review },
          actor: 'dashboard'
        })
      });
      await refresh();
      alert('告警阈值已保存');
    } catch (e) {
      alert(`保存告警阈值失败：${e.message}`);
    }
  });

  document.getElementById('btn-test-alert-channel').addEventListener('click', async () => {
    if (!canAlertChannelEdit()) return showAlertChannelMessage('当前账号无权限（需要 write 或 config scope）', 'error');
    try {
      showAlertChannelMessage('正在测试推送...', '');
      const result = await fetchJSON('/api/config/alert-channels/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-role': me.role },
        body: JSON.stringify({
          webhookUrl: document.getElementById('alert-webhook').value.trim(),
          actor: 'dashboard'
        })
      });
      if (result.ok) showAlertChannelMessage(`测试成功（HTTP ${result.status}）`, 'ok');
      else showAlertChannelMessage(`测试失败（HTTP ${result.status}）`, 'error');
    } catch (e) {
      showAlertChannelMessage(`测试推送失败：${e.message}`, 'error');
    }
  });

  document.getElementById('btn-save-alert-channel').addEventListener('click', async () => {
    if (!canAlertChannelEdit()) return showAlertChannelMessage('当前账号无权限（需要 write 或 config scope）', 'error');
    try {
      showAlertChannelMessage('正在保存推送配置...', '');
      await fetchJSON('/api/config/alert-channels', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-role': me.role },
        body: JSON.stringify({
          webhookUrl: document.getElementById('alert-webhook').value.trim(),
          enabled: document.getElementById('alert-enabled').checked,
          actor: 'dashboard'
        })
      });
      await refresh();
      showAlertChannelMessage('推送配置已保存', 'ok');
    } catch (e) {
      showAlertChannelMessage(`保存推送配置失败：${e.message}`, 'error');
    }
  });
}

function bindSettingsActions() {
  const panel = document.getElementById('settings-panel');
  document.getElementById('btn-open-settings').addEventListener('click', () => panel.classList.remove('hidden'));
  document.getElementById('btn-close-settings').addEventListener('click', () => panel.classList.add('hidden'));
}

async function refresh() {
  const [snapshot, auditLogs, connectorHealth, cronJobs, alertChannel] = await Promise.all([
    fetchJSON('/api/snapshot'),
    fetchJSON('/api/audit-logs?limit=50'),
    fetchJSON('/api/connectors/health'),
    fetchJSON('/api/cron-jobs').catch(() => ({ jobs: [] })),
    fetchJSON('/api/config/alert-channels').catch(() => ({ enabled: false, webhookUrl: '' }))
  ]);
  latestTasks = snapshot.tasks;
  renderAlerts(snapshot.alerts);
  renderMetrics(snapshot.overview);
  renderAlertRules(snapshot.alertRules || {});
  renderAlertChannel(alertChannel || {});
  renderKanban(snapshot.tasks);
  renderAgentTable(snapshot.agents);
  renderConnectorHealth((connectorHealth || {}).rows || []);
  renderCronJobs((cronJobs || {}).jobs || []);
  renderAuditTable(auditLogs);
}

function startSSE() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    latestTasks = data.tasks;
    renderAlerts(data.alerts);
    renderMetrics(data.overview);
    renderAlertRules(data.alertRules || {});
    renderKanban(data.tasks);
    renderAgentTable(data.agents);
    fetchJSON('/api/audit-logs?limit=50').then(renderAuditTable).catch(() => {});
    fetchJSON('/api/connectors/health').then((x) => renderConnectorHealth(x.rows || [])).catch(() => {});
    fetchJSON('/api/cron-jobs').then((x) => renderCronJobs(x.jobs || [])).catch(() => {});
  });
}

async function boot() {
  me = await fetchJSON('/api/me');
  renderSessionInfo();
  bindSettingsActions();
  bindAlertRuleActions();
  await refresh();
  startSSE();
}

boot();

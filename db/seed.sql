-- seed sample data for postgres
insert into agents(id, name, type, status)
values
  ('a1', 'planner-agent', 'planning', 'online'),
  ('a2', 'coder-agent', 'execution', 'online'),
  ('a3', 'review-agent', 'review', 'degraded')
on conflict (id) do nothing;

insert into tasks(id, title, agent_id, priority, status, created_at, started_at, finished_at, retry_count, assignee)
values
  ('t-1001', '生成周报摘要', 'a1', 'high', 'running', '2026-03-06T03:30:00Z', '2026-03-06T03:32:00Z', null, 0, 'planner-agent'),
  ('t-1002', '修复登录页空白问题', 'a2', 'urgent', 'review', '2026-03-06T01:10:00Z', '2026-03-06T01:12:00Z', null, 1, 'coder-agent'),
  ('t-1003', '支付回调异常排查', 'a2', 'high', 'blocked', '2026-03-06T00:20:00Z', '2026-03-06T00:25:00Z', null, 2, 'coder-agent'),
  ('t-1004', '整理竞品功能矩阵', 'a1', 'medium', 'done', '2026-03-05T23:10:00Z', '2026-03-05T23:12:00Z', '2026-03-06T00:02:00Z', 0, 'planner-agent'),
  ('t-1005', '接口契约检查', 'a3', 'low', 'failed', '2026-03-05T18:00:00Z', '2026-03-05T18:10:00Z', '2026-03-05T18:25:00Z', 3, 'review-agent')
on conflict (id) do nothing;

insert into task_events(id, task_id, from_status, to_status, event_type, payload, created_at)
values
  ('e1', 't-1001', 'ready', 'running', 'status_changed', '{"note":"worker started"}', '2026-03-06T03:32:00Z'),
  ('e2', 't-1002', 'running', 'review', 'status_changed', '{"note":"ready for QA"}', '2026-03-06T02:40:00Z'),
  ('e3', 't-1003', 'running', 'blocked', 'status_changed', '{"reason":"missing dependency"}', '2026-03-06T01:30:00Z'),
  ('e4', 't-1005', 'running', 'failed', 'status_changed', '{"error":"contract mismatch"}', '2026-03-05T18:25:00Z')
on conflict (id) do nothing;

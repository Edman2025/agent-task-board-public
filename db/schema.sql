-- Agent Task Board schema (PostgreSQL)

create table if not exists agents (
  id text primary key,
  name text not null,
  type text not null,
  owner text,
  status text not null default 'online',
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id text primary key,
  title text not null,
  agent_id text not null references agents(id),
  priority text not null,
  status text not null,
  assignee text,
  created_at timestamptz not null default now(),
  due_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  retry_count int not null default 0
);

create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_agent_id on tasks(agent_id);

create table if not exists task_events (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  from_status text,
  to_status text,
  event_type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_task_events_task_id on task_events(task_id);
create index if not exists idx_task_events_created_at on task_events(created_at desc);

create table if not exists ingest_dedup (
  event_id text primary key,
  source text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ingest_dedup_created_at on ingest_dedup(created_at desc);

create table if not exists audit_logs (
  id text primary key,
  action text not null,
  actor text,
  task_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_created_at on audit_logs(created_at desc);

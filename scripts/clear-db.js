#!/usr/bin/env node

const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'agent_task_board'
  });

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('truncate table task_events restart identity');
    await client.query('truncate table tasks restart identity');
    await client.query('truncate table agents restart identity');
    await client.query('truncate table ingest_dedup restart identity');
    await client.query('truncate table audit_logs restart identity');
    await client.query('commit');
    console.log('✅ Cleared demo/history data: task_events, tasks, agents, ingest_dedup, audit_logs');
  } catch (e) {
    await client.query('rollback');
    console.error('❌ Failed to clear database:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ Unexpected error:', e.message);
  process.exit(1);
});

-- clear all seeded/demo data (and any existing board data) in PostgreSQL
-- use with caution in non-production environments

begin;

truncate table task_events restart identity;
truncate table tasks restart identity;
truncate table agents restart identity;
truncate table ingest_dedup restart identity;
truncate table audit_logs restart identity;

commit;

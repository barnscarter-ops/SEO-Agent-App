-- Migration 001 — UNIQUE constraint on seo_runs.week_of
-- Run this ONCE against the live Supabase instance (SQL editor).
--
-- Why: scripts/supabase-sync.mjs upserts with { onConflict: 'week_of' }. Postgres
-- only honours ON CONFLICT against a column with a unique (or exclusion) constraint.
-- Without this constraint the upsert cannot dedupe, so re-running the pipeline on the
-- same week inserts duplicate seo_runs rows (and duplicate dashboard cards).
--
-- IMPORTANT: if duplicate week_of rows already exist the ALTER will fail. The
-- de-dupe block below keeps the most recently-created row per week and removes the
-- rest (weekly_posts / website_tasks rows cascade-delete with their run). Review the
-- rows it would drop before running in production.

begin;

-- 1. Remove existing duplicates, keeping the newest run per week.
delete from seo_runs a
using seo_runs b
where a.week_of = b.week_of
  and a.created_at < b.created_at;

-- 2. Add the constraint (idempotent — skips if it already exists).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'unique_week_of'
  ) then
    alter table seo_runs add constraint unique_week_of unique (week_of);
  end if;
end $$;

commit;

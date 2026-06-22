-- Grizzly Electrical Solutions — MCC Pipeline Schema
-- Run this in the Supabase SQL editor to set up all tables

-- ─────────────────────────────────────────────
-- 1. SEO RUNS  (one row per Friday pipeline run)
-- ─────────────────────────────────────────────
create table if not exists seo_runs (
  id                    uuid primary key default gen_random_uuid(),
  week_of               date not null unique,    -- Monday of the content week (one run per week)
  -- UNIQUE is required for the supabase-sync upsert(onConflict: 'week_of') to dedupe
  -- re-runs of the same week instead of inserting duplicate rows.
  status                text not null default 'research_running',
  -- research_running | execute_running | pending_approval | approved | executing | done | error
  research_completed_at timestamptz,
  execute_completed_at  timestamptz,
  approved_at           timestamptz,
  done_at               timestamptz,
  error                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 2. WEEKLY POSTS  (Facebook + GBP)
-- ─────────────────────────────────────────────
create table if not exists weekly_posts (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid references seo_runs(id) on delete cascade,
  platform       text not null,  -- 'facebook' | 'gbp'
  day            int,            -- 1-7 for Facebook; null for GBP
  post_date      date not null,
  type           text,           -- 'video' | 'photo' | 'text'
  service        text,
  hook           text,
  body           text,
  cta            text,
  hashtags       text,
  photo_file     text,
  video_prompt   text,
  video_path     text,           -- local path once generated
  status         text not null default 'pending_approval',
  -- pending_approval | approved | posting | posted | scheduled | error
  platform_post_id text,        -- Facebook post ID or GBP post ID
  scheduled_time timestamptz,
  approved_at    timestamptz,
  posted_at      timestamptz,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 3. WEBSITE TASKS
-- ─────────────────────────────────────────────
create table if not exists website_tasks (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references seo_runs(id) on delete cascade,
  type        text not null,
  -- 'blog_post' | 'service_update' | 'promotion' | 'seo_fix' | 'alert'
  priority    text not null default 'medium',  -- 'critical' | 'high' | 'medium' | 'low'
  title       text not null,
  description text,
  details     jsonb,              -- structured data (page URL, change, etc.)
  status      text not null default 'pending_approval',
  -- pending_approval | approved | executing | done | skipped | error
  approved_at  timestamptz,
  completed_at timestamptz,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 4. RUN LOGS  (stdout/stderr from each phase)
-- ─────────────────────────────────────────────
create table if not exists run_logs (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid references seo_runs(id) on delete cascade,
  phase      text not null,  -- 'research' | 'execute' | 'facebook' | 'gbp' | 'website'
  level      text not null default 'info',  -- 'info' | 'warn' | 'error'
  message    text not null,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
create index if not exists idx_weekly_posts_run_id   on weekly_posts(run_id);
create index if not exists idx_weekly_posts_status   on weekly_posts(status);
create index if not exists idx_weekly_posts_platform on weekly_posts(platform);
create index if not exists idx_website_tasks_run_id  on website_tasks(run_id);
create index if not exists idx_website_tasks_status  on website_tasks(status);
create index if not exists idx_website_tasks_priority on website_tasks(priority);
create index if not exists idx_run_logs_run_id       on run_logs(run_id);
create index if not exists idx_seo_runs_week_of      on seo_runs(week_of desc);

-- ─────────────────────────────────────────────
-- AUTO-UPDATE updated_at
-- ─────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger seo_runs_updated_at
  before update on seo_runs
  for each row execute function set_updated_at();

create or replace trigger weekly_posts_updated_at
  before update on weekly_posts
  for each row execute function set_updated_at();

create or replace trigger website_tasks_updated_at
  before update on website_tasks
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────
-- ENABLE REALTIME (so dashboard gets live updates)
-- ─────────────────────────────────────────────
alter publication supabase_realtime add table seo_runs;
alter publication supabase_realtime add table weekly_posts;
alter publication supabase_realtime add table website_tasks;

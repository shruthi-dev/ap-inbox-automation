-- AP Inbox Triage: core schema
-- Settings (one row), runs + their action items, rollout tracker, and the list of people allowed in.

create extension if not exists pgcrypto;

-- People who may use the console. Add rows by email (lower case).
create table public.app_users (
  email       text primary key check (email = lower(email)),
  full_name   text not null default '',
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Exactly one settings row (id = 1).
create table public.settings (
  id                 int primary key default 1 check (id = 1),
  enabled            boolean not null default false,
  timezone           text not null default 'Asia/Kolkata',
  days               text[] not null default '{Mon,Tue,Wed,Thu,Fri}',
  run_time           time not null default '08:00',
  mailbox            text not null default '',          -- mailbox to read (yours or a shared AP mailbox)
  lookback_days      int not null default 7 check (lookback_days between 1 and 30),
  smart_ap_address   text not null default '',
  auto_forward       boolean not null default false,    -- forward invoices to Smart AP automatically
  report_recipients  text[] not null default '{}',      -- must be people in app_users
  updated_at         timestamptz not null default now(),
  updated_by         text not null default ''
);
insert into public.settings (id) values (1);

create table public.runs (
  id               uuid primary key default gen_random_uuid(),
  trigger          text not null check (trigger in ('schedule', 'manual')),
  status           text not null default 'running' check (status in ('running', 'success', 'failed')),
  mailbox          text not null default '',
  requested_by     text not null default '',
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  emails_reviewed  int not null default 0,
  ap_emails        int not null default 0,
  actions          int not null default 0,
  open_amount      numeric(14,2) not null default 0,
  past_due         int not null default 0,
  report_sent      boolean not null default false,
  forwarded        int not null default 0,
  error            text not null default ''
);
create index runs_started_at_idx on public.runs (started_at desc);

create table public.run_items (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.runs (id) on delete cascade,
  position     int not null,
  priority     text not null check (priority in ('high', 'medium', 'low')),
  category     text not null,
  vendor       text not null default '',
  action       text not null default '',
  amount       numeric(14,2),
  due          text not null default '',
  status       text not null default '',
  why          text not null default '',
  key_facts    text not null default '',
  contact      text not null default '',
  subject      text not null default '',
  sender       text not null default '',
  received_at  timestamptz,
  web_link     text not null default '',
  message_id   text not null default '',
  statement    jsonb not null default '[]'::jsonb   -- statement lines with found/missing status
);
create index run_items_run_idx on public.run_items (run_id, position);

create table public.tracker_items (
  id          text primary key,
  item        text not null,
  status      text not null check (status in ('Done', 'In progress', 'Blocked', 'Not started')),
  note        text not null default '',
  sort        int not null default 0,
  updated_at  timestamptz not null default now()
);

insert into public.tracker_items (id, item, status, note, sort) values
  ('classify',  'Classify AP emails into 5 categories',            'Done',        'Ported from the Claude skill rules', 1),
  ('graph',     'Entra app registration for Microsoft Graph',      'Not started', 'Mail.Read + Mail.Send (application), limited to the AP mailboxes', 2),
  ('apikey',    'Claude API key stored as a function secret',      'Not started', 'ANTHROPIC_API_KEY', 3),
  ('deploy',    'Database, function and scheduler deployed',       'Not started', 'See README', 4),
  ('console',   'Console hosted with company sign-in',             'Not started', 'Static site + Supabase Auth (Microsoft)', 5),
  ('smartap',   'Smart AP inbox address',                          'Not started', 'Needed for routing and auto-forward', 6),
  ('shared',    'Shared AP mailbox access',                        'Not started', 'Application access policy from IT', 7),
  ('yardi',     'Check invoices against Yardi',                    'Blocked',     'No Yardi API access yet; mailbox checks only', 8);

-- ---------- Row level security ----------
create or replace function public.is_app_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

alter table public.app_users     enable row level security;
alter table public.settings      enable row level security;
alter table public.runs          enable row level security;
alter table public.run_items     enable row level security;
alter table public.tracker_items enable row level security;

create policy "members read members"   on public.app_users     for select to authenticated using (public.is_app_user());
create policy "members read settings"  on public.settings      for select to authenticated using (public.is_app_user());
create policy "members edit settings"  on public.settings      for update to authenticated using (public.is_app_user()) with check (public.is_app_user());
create policy "members read runs"      on public.runs          for select to authenticated using (public.is_app_user());
create policy "members read items"     on public.run_items     for select to authenticated using (public.is_app_user());
create policy "members read tracker"   on public.tracker_items for select to authenticated using (public.is_app_user());
create policy "members edit tracker"   on public.tracker_items for update to authenticated using (public.is_app_user()) with check (public.is_app_user());
-- runs / run_items are written only by the Edge Function (service role bypasses RLS).

-- Stamp who changed settings.
create or replace function public.stamp_settings()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end $$;
create trigger settings_stamp before update on public.settings for each row execute function public.stamp_settings();

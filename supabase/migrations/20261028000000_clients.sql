-- AP Inbox Triage: clients
-- Each client has its own mailbox, schedule, recipients and Smart AP routing (what the single settings row held),
-- its own run history, and its own list of people who can see it. Admins see every client and manage access.
-- The existing settings row becomes the first client, and existing runs are attached to it.

create table public.clients (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(trim(name)) > 0),
  enabled            boolean not null default false,
  timezone           text not null default 'Asia/Kolkata',
  days               text[] not null default '{Mon,Tue,Wed,Thu,Fri}',
  run_time           time not null default '08:00',
  mailbox            text not null default '',
  lookback_days      int not null default 7 check (lookback_days between 1 and 30),
  smart_ap_address   text not null default '',
  auto_forward       boolean not null default false,
  report_recipients  text[] not null default '{}',      -- must be people with access to this client
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         text not null default ''
);
create unique index clients_name_idx on public.clients (lower(name));

-- Who may see and run each client (admins see all clients without a row here).
create table public.client_users (
  client_id   uuid not null references public.clients (id) on delete cascade,
  email       text not null references public.app_users (email) on delete cascade on update cascade,
  created_at  timestamptz not null default now(),
  primary key (client_id, email)
);
create index client_users_email_idx on public.client_users (email);

-- Move the single settings row into the first client.
insert into public.clients (name, enabled, timezone, days, run_time, mailbox, lookback_days, smart_ap_address, auto_forward, report_recipients, updated_by)
select coalesce(nullif(split_part(mailbox, '@', 1), ''), 'First client'),
       enabled, timezone, days, run_time, mailbox, lookback_days, smart_ap_address, auto_forward, report_recipients, updated_by
from public.settings where id = 1;

insert into public.client_users (client_id, email)
select c.id, r.email
from public.clients c
cross join lateral unnest(c.report_recipients) as r(email)
where exists (select 1 from public.app_users u where u.email = r.email)
on conflict do nothing;

-- Runs belong to a client.
alter table public.runs add column client_id uuid references public.clients (id) on delete cascade;
update public.runs set client_id = (select id from public.clients order by created_at limit 1) where client_id is null;
alter table public.runs alter column client_id set not null;
drop index if exists public.runs_started_at_idx;
create index runs_client_started_idx on public.runs (client_id, started_at desc);

drop table public.settings;
drop function if exists public.stamp_settings();

-- ---------- Row level security ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where email = lower(coalesce(auth.jwt() ->> 'email', '')) and is_admin);
$$;

create or replace function public.can_see_client(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.client_users where client_id = cid and email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

alter table public.clients      enable row level security;
alter table public.client_users enable row level security;

create policy "see own clients"       on public.clients for select to authenticated using (public.can_see_client(id));
create policy "admins add clients"    on public.clients for insert to authenticated with check (public.is_admin());
create policy "members edit clients"  on public.clients for update to authenticated using (public.can_see_client(id)) with check (public.can_see_client(id));
create policy "admins delete clients" on public.clients for delete to authenticated using (public.is_admin());

create policy "see client access"     on public.client_users for select to authenticated using (public.can_see_client(client_id));
create policy "admins grant access"   on public.client_users for insert to authenticated with check (public.is_admin());
create policy "admins revoke access"  on public.client_users for delete to authenticated using (public.is_admin());

create policy "admins add members"    on public.app_users for insert to authenticated with check (public.is_admin());
create policy "admins edit members"   on public.app_users for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy "members read runs"  on public.runs;
drop policy "members read items" on public.run_items;
create policy "see client runs"  on public.runs      for select to authenticated using (public.can_see_client(client_id));
create policy "see client items" on public.run_items for select to authenticated
  using (exists (select 1 from public.runs r where r.id = run_id and public.can_see_client(r.client_id)));

-- Stamp who changed a client's settings.
create or replace function public.stamp_client()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end $$;
create trigger clients_stamp before update on public.clients for each row execute function public.stamp_client();

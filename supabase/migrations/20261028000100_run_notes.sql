-- AP Inbox Triage: keep each check's report notes and look-back period, so the console can show the full summary the email had.
alter table public.runs
  add column notes jsonb not null default '[]'::jsonb,   -- the report's Notes section, in order
  add column lookback_days int;                           -- look-back used for this check

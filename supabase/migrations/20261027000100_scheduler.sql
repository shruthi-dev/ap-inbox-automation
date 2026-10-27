-- AP Inbox Triage: scheduler
-- pg_cron calls the triage Edge Function every 5 minutes with mode "tick".
-- The function itself decides whether a run is due (settings: enabled, days, run_time, timezone),
-- so changing the schedule in the console never requires touching this job.
--
-- Before this works, store two secrets in Vault (SQL editor, once):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<same value as the CRON_SECRET function secret>', 'cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ap-triage-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/triage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{"mode":"tick"}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

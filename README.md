# AP Inbox Triage (Supabase)

A standalone version of the AP Inbox Triage. It reads an Outlook mailbox through Microsoft Graph, uses Claude to read each AP email and its PDFs, emails a prioritised report, and keeps settings and run history in Supabase. The console lets people set the schedule, press **Run now**, review runs and track the rollout.

The Claude Code skill in `C:\claude\claudeSkill` is untouched and keeps working on its own. This project reuses its triage rules (see `supabase/functions/_shared/rules.ts`).

No Docker is needed. Everything deploys to your hosted Supabase project with `npx supabase`.

## How it works

| Part | Where | What it does |
|---|---|---|
| Database | `supabase/migrations/…_init.sql` | `settings` (one row), `runs`, `run_items`, `tracker_items`, `app_users`, with row-level security so only listed users can read or change anything |
| Scheduler | `supabase/migrations/…_scheduler.sql` | `pg_cron` calls the function every 5 minutes; the function runs only when the console's schedule says so |
| Runner | `supabase/functions/triage/` | Lists the inbox for the look-back window, asks Claude which emails are AP, reads each one (body + PDFs) with Claude, checks statement invoices against the mailbox, optionally forwards invoices to Smart AP, emails the report, saves the run |
| Console | `web/` | Static page: Microsoft or email-link sign-in, Overview, Schedule, Run history, Rollout |

Claude model: `claude-opus-5-5`, with server-side refusal fallback to `claude-opus-4-8` enabled. A quick low-effort pass filters the inbox first, so only likely AP emails get the full read.

## What you need

1. **A Supabase project** (supabase.com → New project; pick the region closest to you, e.g. Mumbai). Note the project ref (the `xxxx` in `https://xxxx.supabase.co`).
2. **A Claude API key** from console.anthropic.com.
3. **Two Entra app registrations** from IT:
   - **AP Triage Mail** (for the runner): API permissions → Microsoft Graph → *Application* permissions `Mail.Read` and `Mail.Send` → **Grant admin consent**. Create a client secret. Ask IT to limit it to the AP mailboxes with an Exchange application access policy, for example:
     ```powershell
     New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId ap-triage-mailboxes@yourcompany.com -AccessRight RestrictAccess -Description "AP Triage mailboxes only"
     ```
   - **AP Triage Sign-in** (for the console): platform *Web*, redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`, delegated permission `email`. Create a client secret.
4. Node.js (already installed on this PC).

## Deploy (PowerShell, from this folder)

Use `npx.cmd` in PowerShell, because Windows blocks `.ps1` launchers.

```powershell
cd C:\claude\ap-inbox-automation

# 1. Sign in to Supabase (opens the browser) and link this folder to your project
npx.cmd supabase login
npx.cmd supabase link --project-ref <project-ref>

# 2. Create the tables, security rules and scheduler job
npx.cmd supabase db push

# 3. Store the secrets (copy .env.example to .env and fill it in first)
copy supabase\functions\.env.example supabase\functions\.env
notepad supabase\functions\.env
npx.cmd supabase secrets set --env-file supabase\functions\.env

# 4. Deploy the function without Docker
npx.cmd supabase functions deploy triage --use-api
```

Then, in the Supabase dashboard:

5. **SQL editor:** run these once. `cron_secret` must equal `CRON_SECRET` in your `.env`. The last line adds you as the first user.
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
   select vault.create_secret('<your CRON_SECRET value>', 'cron_secret');
   insert into public.app_users (email, full_name, is_admin) values ('shruthi.subbarao@contractio.com', 'Shruthi Rao', true);
   ```
6. **Authentication → Sign In / Providers → Azure:** turn it on, then enter the *AP Triage Sign-in* client ID and secret, and the tenant URL `https://login.microsoftonline.com/<tenant-id>`.
7. **Authentication → URL Configuration:** set **Site URL** to wherever the console will live, and add the same address under **Redirect URLs** (add `http://localhost:3000` too, for testing on this PC).

## Run the console

Put your project URL and **anon public key** (Project Settings → API) into `web/config.js`.

- **Test on this PC:** `npx.cmd serve web -l 3000`, then open http://localhost:3000.
- **Publish for the team:** upload the `web` folder to any static host. Azure Static Web Apps fits a Microsoft shop; Netlify Drop (drag the folder onto app.netlify.com/drop) is the quickest. Add the published address to Supabase's Redirect URLs.

## First run

1. Sign in, open **Schedule**, and fill in:
   - **Mailbox to check:** your mailbox, or the shared AP mailbox.
   - **Report recipients:** you.
   - **Run time, days and time zone.**
   - **Smart AP address**, if you have it. Leave **auto-forward off** until you've checked a few reports.
2. **Save**, then go to **Overview → Run now**. The report arrives by email, and the run appears in **Run history**.
3. When the reports look right, tick **Run the triage on a schedule**.

## Limits and costs

- **Function time limit:** Edge Functions stop after 150 s on the Free plan and 400 s on Pro. A run reads at most 25 AP emails (`MAX_DEEP` in `triage/index.ts`), three at a time. On the Free plan, lower `MAX_DEEP` to about 10, or shorten the look-back.
- **Claude cost:** a few cents per AP email read in full (Opus 5.5: $4 input / $20 output per million tokens), plus one small filtering call per run.
- **Statement checks:** these search the mailbox only. Yardi isn't connected.
- **Auto-forward:** Graph forwards the original email with its attachments. Emails flagged for bank or remittance changes, or containing instructions aimed at the assistant, are never forwarded automatically.
- **Who receives the report:** only addresses on the `app_users` list. Anything else in *Report recipients* is skipped.

## Keeping the rules in step

The AP rules exist in two places: the skill (`claudeSkill/.claude/skills/ap-inbox-triage/SKILL.md`) and `supabase/functions/_shared/rules.ts`. When the AP team changes a rule, update both, then redeploy the function:

```powershell
npx.cmd supabase functions deploy triage --use-api
```

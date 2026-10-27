// AP Inbox Triage runner.
//   POST {"mode":"tick"}                    from pg_cron every 5 min (header x-cron-secret) - starts the next client that is due
//   POST {"mode":"manual","client_id":...}  from the console's "Check inbox now" (user's Supabase token) - runs that client now
// Each call runs at most one client, so every run gets the function's full time limit.
// The run continues in the background after the response; progress is written to the runs table.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { forwardMessage, getBodyText, getPdfAttachments, listInbox, searchMailbox, sendHtmlMail, type MailSummary } from "../_shared/graph.ts";
import { pickApCandidates, triageEmail, type Triage } from "../_shared/classify.ts";
import { buildReportHtml, reportSubject, type ReportItem } from "../_shared/report.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const MAX_DEEP = 25; // emails read in depth per run (keeps a run inside the function time limit)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

interface Settings {
  id: string; name: string; enabled: boolean; timezone: string; days: string[]; run_time: string; mailbox: string;
  lookback_days: number; smart_ap_address: string; auto_forward: boolean; report_recipients: string[];
}

function localParts(tz: string, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, ymd: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

async function isDue(s: Settings): Promise<{ due: boolean; reason: string }> {
  if (!s.enabled) return { due: false, reason: "scheduler off" };
  const now = localParts(s.timezone);
  if (!s.days.includes(now.weekday)) return { due: false, reason: `not a run day (${now.weekday})` };
  const [h, m] = s.run_time.split(":").map(Number);
  const target = h * 60 + m;
  if (now.minutes < target || now.minutes > target + 120) return { due: false, reason: "not run time" };
  const { data } = await db.from("runs").select("started_at").eq("client_id", s.id).eq("trigger", "schedule")
    .gte("started_at", new Date(Date.now() - 30 * 3600_000).toISOString());
  if ((data ?? []).some((r) => localParts(s.timezone, new Date(r.started_at)).ymd === now.ymd)) {
    return { due: false, reason: "already ran today" };
  }
  return { due: true, reason: "due" };
}

async function runningNow(clientId: string): Promise<boolean> {
  const { data } = await db.from("runs").select("id").eq("client_id", clientId).eq("status", "running")
    .gte("started_at", new Date(Date.now() - 15 * 60_000).toISOString()).limit(1);
  return !!data?.length;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const PRIO_ORDER = { high: 0, medium: 1, low: 2 } as const;
const toAmount = (s: string) => { const n = Number(String(s).replace(/[^0-9.\-]/g, "")); return s && Number.isFinite(n) ? n : null; };

async function recipients(s: Settings, requestedBy: string): Promise<string[]> {
  const [{ data: users }, { data: access }] = await Promise.all([
    db.from("app_users").select("email,is_admin"),
    db.from("client_users").select("email").eq("client_id", s.id),
  ]);
  const members = new Set([...(users ?? []).filter((u) => u.is_admin), ...(access ?? [])].map((u) => u.email));
  let to = (s.report_recipients ?? []).map((e) => e.toLowerCase()).filter((e) => members.has(e));
  if (!to.length && requestedBy) to = [requestedBy];
  if (!to.length) to = (users ?? []).filter((u) => u.is_admin).map((u) => u.email);
  return to;
}

async function doRun(runId: string, trigger: "schedule" | "manual", s: Settings, requestedBy: string) {
  const notes: string[] = [];
  try {
    if (!s.mailbox) throw new Error(`No mailbox is set for ${s.name}. Add one on its Settings tab.`);
    const since = new Date(Date.now() - s.lookback_days * 86400_000);
    const all = (await listInbox(s.mailbox, since.toISOString())).filter((m) => !/^(\[Manual\] )?AP Triage /.test(m.subject));
    const picked = await pickApCandidates(all);
    let candidates = all.filter((m) => picked.has(m.id));
    if (candidates.length > MAX_DEEP) {
      notes.push(`${candidates.length} possible AP emails found; the newest ${MAX_DEEP} were read. Run again or shorten the look-back to cover the rest.`);
      candidates = candidates.slice(0, MAX_DEEP);
    }
    const today = localParts(s.timezone).ymd;

    const results = await mapLimit(candidates, 3, async (m: MailSummary) => {
      const [body, att] = await Promise.all([getBodyText(s.mailbox, m.id), m.hasAttachments ? getPdfAttachments(s.mailbox, m.id) : Promise.resolve({ pdfs: [], otherNames: [] })]);
      const t = await triageEmail(m, body, att.pdfs, att.otherNames, today);
      return { m, t };
    });

    let refused = 0, notAp = all.length - candidates.length, forwarded = 0;
    const items: (ReportItem & { past_due: boolean; message_id: string })[] = [];
    for (const { m, t } of results) {
      if ("refused" in t) { refused++; continue; }
      const tri = t as Triage;
      if (tri.category === "not_ap") { notAp++; continue; }
      if (tri.injection_attempt) notes.push(`"${m.subject}" contains instructions aimed at the assistant; they were ignored. Check it by hand.`);
      if (tri.bank_or_remit_change) notes.push(`${tri.vendor}: bank or remittance details change - verify by phone on a known number before use.`);

      const statement = [];
      for (const line of tri.statement_lines) {
        if (!line.invoice_number) continue;
        const hits = (await searchMailbox(s.mailbox, line.invoice_number)).filter((h) => h.id !== m.id);
        statement.push({ ...line, found: hits.length > 0, evidence: hits.length ? `in "${hits[0].subject}"` : "not in mailbox" });
      }
      const missing = statement.filter((l) => !l.found).length;

      let didForward = false;
      if (s.auto_forward && s.smart_ap_address && tri.category === "invoice" && !tri.bank_or_remit_change && !tri.injection_attempt) {
        try {
          await forwardMessage(s.mailbox, m.id, s.smart_ap_address, "Forwarded by AP Inbox Triage.");
          didForward = true; forwarded++;
        } catch (e) { notes.push(`Couldn't forward "${m.subject}" to Smart AP: ${(e as Error).message}`); }
      }

      items.push({
        position: 0,
        priority: missing || tri.likely_past_due || tri.bank_or_remit_change ? "high" : tri.priority,
        category: tri.category,
        vendor: tri.vendor || m.fromName || m.from,
        action: tri.category === "account_statement" && missing ? `Request ${missing} missing invoice${missing === 1 ? "" : "s"}` : tri.action,
        amount: toAmount(tri.amount),
        due: tri.likely_past_due ? (tri.due ? `${tri.due} (past due)` : "Past due") : tri.due,
        status: tri.category === "account_statement" && !missing ? "All invoices found" : tri.status,
        why: tri.why,
        key_facts: [tri.key_facts, tri.notes].filter(Boolean).join(" · "),
        contact: tri.contact,
        subject: m.subject,
        sender: m.from,
        received_at: m.receivedDateTime,
        web_link: m.webLink,
        statement,
        forwarded: didForward,
        past_due: tri.likely_past_due,
        message_id: m.id,
      });
    }
    items.sort((a, b) => PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]);
    items.forEach((it, i) => (it.position = i + 1));

    notes.unshift("Statement invoices were checked against this mailbox only (no Yardi connection yet).");
    if (!s.smart_ap_address) notes.push("The Smart AP inbox address isn't set, so invoices weren't routed.");
    else if (!s.auto_forward) notes.push("Auto-forward is off; forward invoices to Smart AP by hand.");
    if (refused) notes.push(`${refused} email(s) couldn't be classified automatically; check them by hand.`);

    const dateLabel = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, day: "numeric", month: "short", year: "numeric" }).format(new Date());
    const ignored: Record<string, number> = notAp ? { "Not AP": notAp } : {};
    const report = {
      dateLabel, client: s.name, mailbox: s.mailbox, trigger, reviewed: all.length, apCount: items.length,
      periodLabel: `last ${s.lookback_days} day${s.lookback_days === 1 ? "" : "s"}`,
      ignored, items, notes, smartAp: s.smart_ap_address,
    };
    const to = await recipients(s, requestedBy);
    if (!to.length) throw new Error("No one to send the summary to. Add someone with access to this client under 'Send the summary to'.");
    await sendHtmlMail(s.mailbox, to, reportSubject(report), buildReportHtml(report));

    if (items.length) {
      const { error } = await db.from("run_items").insert(items.map((it) => ({
        run_id: runId, position: it.position, priority: it.priority, category: it.category, vendor: it.vendor,
        action: it.action, amount: it.amount, due: it.due, status: it.forwarded ? "Forwarded to Smart AP" : it.status,
        why: it.why, key_facts: it.key_facts, contact: it.contact, subject: it.subject, sender: it.sender,
        received_at: it.received_at, web_link: it.web_link, message_id: it.message_id, statement: it.statement,
      })));
      if (error) throw new Error(`Saving run items failed: ${error.message}`);
    }
    await db.from("runs").update({
      status: "success", finished_at: new Date().toISOString(), emails_reviewed: all.length, ap_emails: items.length,
      actions: items.filter((i) => i.status !== "No action" && !i.forwarded).length,
      open_amount: items.reduce((a, i) => a + (i.amount ?? 0), 0),
      past_due: items.filter((i) => i.past_due).length, report_sent: true, forwarded,
    }).eq("id", runId);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    console.error("triage run failed", message);
    await db.from("runs").update({ status: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 1000) }).eq("id", runId);
    try {
      const to = await recipients(s, requestedBy);
      if (s.mailbox && to.length) {
        await sendHtmlMail(s.mailbox, to, `AP Triage · ${s.name} — check failed`, `<p>The AP inbox check for <b>${s.name.replace(/</g, "&lt;")}</b> failed:</p><p><b>${message.replace(/</g, "&lt;")}</b></p>`);
      }
    } catch { /* the run row already holds the error */ }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "manual" ? "manual" : body.mode === "tick" ? "tick" : null;
  if (!mode) return json({ error: 'mode must be "tick" or "manual"' }, 400);

  let requestedBy = "";
  let clientId = "";
  if (mode === "tick") {
    const secret = Deno.env.get("CRON_SECRET");
    if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "Not allowed" }, 401);
  } else {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data, error } = await db.auth.getUser(jwt);
    const email = data?.user?.email?.toLowerCase();
    if (error || !email) return json({ error: "Sign in first" }, 401);
    clientId = String(body.client_id ?? "");
    if (!clientId) return json({ error: "Pick a client first" }, 400);
    const [{ data: member }, { data: access }] = await Promise.all([
      db.from("app_users").select("is_admin").eq("email", email).maybeSingle(),
      db.from("client_users").select("email").eq("client_id", clientId).eq("email", email).maybeSingle(),
    ]);
    if (!member || (!member.is_admin && !access)) return json({ error: "You don't have access to this client" }, 403);
    requestedBy = email;
  }

  let settings: Settings;
  if (mode === "manual") {
    const { data: c } = await db.from("clients").select("*").eq("id", clientId).maybeSingle();
    if (!c) return json({ error: "Client not found" }, 404);
    settings = c as Settings;
    if (await runningNow(settings.id)) return json({ ran: false, reason: "This client is already being checked" }, 409);
  } else {
    const { data: clients, error: cErr } = await db.from("clients").select("*").eq("enabled", true).order("run_time").order("name");
    if (cErr) return json({ error: `Couldn't load clients: ${cErr.message}` }, 500);
    let next: Settings | null = null;
    const skipped: Record<string, string> = {};
    for (const c of (clients ?? []) as Settings[]) {
      const { due, reason } = await isDue(c);
      if (due && !(await runningNow(c.id))) { next = c; break; }
      skipped[c.name] = due ? "already running" : reason;
    }
    if (!next) return json({ ran: false, skipped });
    settings = next;
  }

  const trigger = mode === "tick" ? "schedule" : "manual";
  const { data: run, error: rErr } = await db.from("runs")
    .insert({ client_id: settings.id, trigger, mailbox: settings.mailbox, requested_by: requestedBy }).select("id").single();
  if (rErr || !run) return json({ error: `Couldn't start the run: ${rErr?.message}` }, 500);

  EdgeRuntime.waitUntil(doRun(run.id, trigger, settings, requestedBy));
  return json({ ran: true, runId: run.id, client: settings.name, trigger }, 202);
});

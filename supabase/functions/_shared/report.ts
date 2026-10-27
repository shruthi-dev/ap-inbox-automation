// Builds the HTML report email. Graph sends full HTML, so tables keep real alignment.

export interface ReportItem {
  position: number;
  priority: "high" | "medium" | "low";
  category: string;
  vendor: string;
  action: string;
  amount: number | null;
  due: string;
  status: string;
  why: string;
  key_facts: string;
  contact: string;
  subject: string;
  sender: string;
  received_at: string;
  web_link: string;
  statement: { invoice_number: string; date: string; description: string; amount: string; found: boolean; evidence: string }[];
  forwarded: boolean;
  past_due: boolean;
}

export interface ReportInput {
  dateLabel: string;
  client: string;
  mailbox: string;
  periodLabel: string;
  trigger: "schedule" | "manual";
  reviewed: number;
  apCount: number;
  ignored: Record<string, number>;
  items: ReportItem[];
  notes: string[];
  smartAp: string;
}

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (n: number | null) => n == null ? "&mdash;" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PRIO: Record<string, [string, string, string]> = {
  high: ["High", "#b23a2e", "#f9e5e2"],
  medium: ["Medium", "#8a5800", "#fbf0d9"],
  low: ["Low", "#2f5687", "#e8eef6"],
};
const CAT: Record<string, string> = {
  invoice: "Invoice", utility_bill: "Utility / portal bill", vendor_info: "Vendor information",
  account_statement: "Account statement", other: "Other",
};

const TD = "padding:8px 10px;border-bottom:1px solid #dce3df;vertical-align:top;";
const TH = "padding:8px 10px;border-bottom:2px solid #b9c4be;background:#f4f6f4;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b6862;";

export function reportSubject(r: ReportInput): string {
  const open = r.items.reduce((a, i) => a + (i.amount ?? 0), 0);
  const past = r.items.filter((i) => i.past_due).length;
  let s = `AP Triage · ${r.client} · ${r.dateLabel} — ${r.items.length} action${r.items.length === 1 ? "" : "s"} · ${money(open).replace("&mdash;", "$0.00")} open`;
  if (past) s += ` · ${past} past due`;
  return (r.trigger === "manual" ? "[Manual] " : "") + s;
}

export function buildReportHtml(r: ReportInput): string {
  const open = r.items.reduce((a, i) => a + (i.amount ?? 0), 0);
  const rows = r.items.map((i) => {
    const [label, fg, bg] = PRIO[i.priority];
    return `<tr>
      <td style="${TD}text-align:center;">${i.position}</td>
      <td style="${TD}text-align:center;"><span style="background:${bg};color:${fg};padding:2px 8px;border-radius:10px;font-weight:600;font-size:12px;">${label}</span></td>
      <td style="${TD}">${esc(i.vendor)}</td>
      <td style="${TD}">${esc(CAT[i.category] ?? i.category)}</td>
      <td style="${TD}">${esc(i.action)}</td>
      <td style="${TD}text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${money(i.amount)}</td>
      <td style="${TD}text-align:center;white-space:nowrap;">${esc(i.due || "—")}</td>
      <td style="${TD}">${esc(i.forwarded ? "Forwarded to Smart AP" : i.status)}</td>
    </tr>`;
  }).join("");

  const details = r.items.map((i) => {
    const [label] = PRIO[i.priority];
    return `<div style="margin:14px 0;padding-top:10px;border-top:1px solid #dce3df;">
      <p style="margin:0 0 6px;font-weight:600;">${i.position}. ${esc(i.vendor)} — ${esc(i.action)} <span style="color:#5b6862;font-weight:400;">(${label})</span></p>
      <ul style="margin:0;padding-left:20px;">
        <li><b>Why:</b> ${esc(i.why)}</li>
        <li><b>Email:</b> "${esc(i.subject)}" from ${esc(i.sender)}, ${esc(i.received_at)}${i.web_link ? ` · <a href="${esc(i.web_link)}">Open email</a>` : ""}</li>
        ${i.key_facts ? `<li><b>Key facts:</b> ${esc(i.key_facts)}</li>` : ""}
        ${i.contact ? `<li><b>Contact:</b> ${esc(i.contact)}</li>` : ""}
        ${i.category === "invoice" && r.smartAp && !i.forwarded ? `<li><b>Forward to:</b> ${esc(r.smartAp)}</li>` : ""}
      </ul></div>`;
  }).join("");

  const statements = r.items.filter((i) => i.statement.length).map((i) => {
    const lines = i.statement.map((l) => `<tr>
      <td style="${TD}">${esc(l.invoice_number)}</td>
      <td style="${TD}text-align:center;white-space:nowrap;">${esc(l.date)}</td>
      <td style="${TD}">${esc(l.description)}</td>
      <td style="${TD}text-align:right;font-variant-numeric:tabular-nums;">${esc(l.amount)}</td>
      <td style="${TD}">${l.found ? "Found" : "<b>Missing</b>"} <span style="color:#5b6862;">${esc(l.evidence)}</span></td></tr>`).join("");
    return `<h3 style="font-size:15px;margin:22px 0 8px;">Statement reconciliation — ${esc(i.vendor)}</h3>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;">
        <tr><th style="${TH}text-align:left;">Invoice #</th><th style="${TH}text-align:center;">Date</th><th style="${TH}text-align:left;">Description</th><th style="${TH}text-align:right;">Amount</th><th style="${TH}text-align:left;">Status</th></tr>
        ${lines}</table>`;
  }).join("");

  const ignored = Object.entries(r.ignored).map(([k, v]) => `${esc(k)} (${v})`).join(", ");

  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#17201c;font-size:14px;line-height:1.5;max-width:960px;">
  <h2 style="font-size:20px;margin:0 0 4px;">${esc(r.client)} — AP inbox summary, ${esc(r.dateLabel)}</h2>
  <p style="margin:0 0 16px;color:#5b6862;">Mailbox ${esc(r.mailbox)} · ${esc(r.periodLabel)} · Reviewed ${r.reviewed} emails (AP ${r.apCount}) · ${r.trigger === "manual" ? "Manual run" : "Scheduled run"}</p>
  <h3 style="font-size:15px;margin:0 0 8px;">Summary</h3>
  ${r.items.length ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;">
    <tr><th style="${TH}text-align:center;">#</th><th style="${TH}text-align:center;">Priority</th><th style="${TH}text-align:left;">Vendor</th><th style="${TH}text-align:left;">Category</th><th style="${TH}text-align:left;">What to do</th><th style="${TH}text-align:right;">Amount</th><th style="${TH}text-align:center;">Due</th><th style="${TH}text-align:left;">Status</th></tr>
    ${rows}
    <tr><td colspan="5" style="${TD}text-align:right;font-weight:600;">Total open</td><td style="${TD}text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${money(open)}</td><td colspan="2" style="${TD}"></td></tr>
  </table>` : `<p>Nothing needs your attention.</p>`}
  ${r.items.length ? `<h3 style="font-size:15px;margin:22px 0 0;">Details</h3>${details}` : ""}
  ${statements}
  <h3 style="font-size:15px;margin:22px 0 8px;">Notes</h3>
  <ul style="margin:0;padding-left:20px;">
    ${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}
    ${ignored ? `<li>Not AP, ignored: ${ignored}.</li>` : ""}
  </ul>
  <p style="color:#5b6862;font-size:12px;margin-top:20px;">Generated by AP Inbox Triage (Supabase).</p>
</div>`;
}

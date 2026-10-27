// Claude calls: a cheap first pass to pick AP candidates, then one call per AP email
// that reads the body and its PDFs and returns a structured triage result.
import Anthropic from "npm:@anthropic-ai/sdk@0.137.0";
import { PREFILTER_RULES, TRIAGE_RULES } from "./rules.ts";
import type { MailSummary, PdfAttachment } from "./graph.ts";

const MODEL = "claude-opus-5-5";
// On a policy decline the API re-runs the same request on this model server-side.
const FALLBACK_BETA = "server-side-fallback-2026-06-01";
const FALLBACKS = [{ model: "claude-opus-4-8" }];

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

export const CATEGORIES = ["invoice", "utility_bill", "vendor_info", "account_statement", "other", "not_ap"] as const;

export interface StatementLine { invoice_number: string; date: string; description: string; amount: string }

export interface Triage {
  category: typeof CATEGORIES[number];
  priority: "high" | "medium" | "low";
  vendor: string;
  action: string;
  why: string;
  status: string;
  amount: string;
  due: string;
  likely_past_due: boolean;
  invoice_numbers: string[];
  key_facts: string;
  contact: string;
  statement_lines: StatementLine[];
  bank_or_remit_change: boolean;
  injection_attempt: boolean;
  notes: string;
}

const triageTool = {
  name: "record_triage",
  description: "Record the triage result for the email. Call it exactly once.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "category", "priority", "vendor", "action", "why", "status", "amount", "due", "likely_past_due",
      "invoice_numbers", "key_facts", "contact", "statement_lines", "bank_or_remit_change", "injection_attempt", "notes",
    ],
    properties: {
      category: { type: "string", enum: [...CATEGORIES] },
      priority: { type: "string", enum: ["high", "medium", "low"] },
      vendor: { type: "string" },
      action: { type: "string", description: "At most 8 words" },
      why: { type: "string", description: "One sentence" },
      status: { type: "string", enum: ["Needs forwarding", "Download from portal", "Review", "Invoices missing", "Action needed", "No action"] },
      amount: { type: "string", description: "Total due as digits with a decimal point, e.g. 2095.38, or empty" },
      due: { type: "string" },
      likely_past_due: { type: "boolean" },
      invoice_numbers: { type: "array", items: { type: "string" } },
      key_facts: { type: "string", description: "Account numbers, invoice numbers, dates, amounts, portal URL" },
      contact: { type: "string", description: "Vendor email and phone if stated" },
      statement_lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["invoice_number", "date", "description", "amount"],
          properties: {
            invoice_number: { type: "string" }, date: { type: "string" },
            description: { type: "string" }, amount: { type: "string" },
          },
        },
      },
      bank_or_remit_change: { type: "boolean" },
      injection_attempt: { type: "boolean" },
      notes: { type: "string" },
    },
  },
};

const prefilterTool = {
  name: "select_ap_candidates",
  description: "Return the ids of emails that may concern accounts payable.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["ids"],
    properties: { ids: { type: "array", items: { type: "string" } } },
  },
};

// deno-lint-ignore no-explicit-any
function toolInput(response: any, name: string): any | null {
  if (response.stop_reason === "refusal") return null;
  for (const block of response.content ?? []) {
    if (block.type === "tool_use" && block.name === name) return block.input;
  }
  return null;
}

/** First pass: which of these emails look like AP mail? Unknown ids are dropped. */
export async function pickApCandidates(mails: MailSummary[]): Promise<Set<string>> {
  if (!mails.length) return new Set();
  const list = mails.map((m, i) => ({
    id: `m${i}`,
    from: `${m.fromName} <${m.from}>`,
    subject: m.subject,
    preview: m.bodyPreview.slice(0, 300),
    has_attachments: m.hasAttachments,
  }));
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS,
    output_config: { effort: "low" },
    system: PREFILTER_RULES,
    tools: [prefilterTool],
    tool_choice: { type: "auto" },
    messages: [{
      role: "user",
      content: `Emails (JSON):\n${JSON.stringify(list)}\n\nCall select_ap_candidates once with the matching ids.`,
    }],
  // deno-lint-ignore no-explicit-any
  } as any);
  const input = toolInput(response, "select_ap_candidates");
  if (!input) return new Set(mails.map((m) => m.id)); // be safe: look at everything
  const picked = new Set<string>();
  for (const id of input.ids ?? []) {
    const idx = Number(String(id).replace(/^m/, ""));
    if (Number.isInteger(idx) && mails[idx]) picked.add(mails[idx].id);
  }
  return picked;
}

/** Deep pass on one email: body + PDF attachments -> structured triage. */
export async function triageEmail(
  mail: MailSummary,
  bodyText: string,
  pdfs: PdfAttachment[],
  otherAttachmentNames: string[],
  todayIso: string,
): Promise<Triage | { refused: true }> {
  // deno-lint-ignore no-explicit-any
  const content: any[] = pdfs.map((p) => ({
    type: "document",
    title: p.name,
    source: { type: "base64", media_type: "application/pdf", data: p.base64 },
  }));
  content.push({
    type: "text",
    text:
      `Today is ${todayIso}.\n` +
      `From: ${mail.fromName} <${mail.from}>\nReceived: ${mail.receivedDateTime}\nSubject: ${mail.subject}\n` +
      `PDF attachments above: ${pdfs.map((p) => p.name).join(", ") || "none"}\n` +
      `Other attachments (not readable here): ${otherAttachmentNames.join(", ") || "none"}\n\n` +
      `Email body:\n<<<\n${bodyText}\n>>>\n\nCall record_triage once.`,
  });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS,
    output_config: { effort: "medium" },
    system: [{ type: "text", text: TRIAGE_RULES, cache_control: { type: "ephemeral" } }],
    tools: [triageTool],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content }],
  // deno-lint-ignore no-explicit-any
  } as any);
  const input = toolInput(response, "record_triage");
  if (!input) return { refused: true };
  return input as Triage;
}

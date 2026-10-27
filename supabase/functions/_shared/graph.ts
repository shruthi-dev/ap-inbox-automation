// Microsoft Graph access with an Entra app registration (client credentials).
// Needs application permissions Mail.Read and Mail.Send, granted by an admin and
// limited to the AP mailboxes with an Exchange application access policy.

const GRAPH = "https://graph.microsoft.com/v1.0";

let cachedToken: { value: string; expires: number } | null = null;

async function token(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const tenant = Deno.env.get("MS_TENANT_ID");
  const clientId = Deno.env.get("MS_CLIENT_ID");
  const secret = Deno.env.get("MS_CLIENT_SECRET");
  if (!tenant || !clientId || !secret) throw new Error("Microsoft Graph secrets are not set (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET)");
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Microsoft sign-in failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function graph(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path.startsWith("http") ? path : GRAPH + path, {
    ...init,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 || res.status === 404) {
      throw new Error(`Graph refused ${path.split("?")[0]} (${res.status}). Check the app's mailbox access. ${body.slice(0, 300)}`);
    }
    throw new Error(`Graph error ${res.status} on ${path.split("?")[0]}: ${body.slice(0, 300)}`);
  }
  return res;
}

const mbx = (mailbox: string) => `/users/${encodeURIComponent(mailbox)}`;

export interface MailSummary {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  receivedDateTime: string;
  hasAttachments: boolean;
  bodyPreview: string;
  webLink: string;
  internetMessageId: string;
}

export async function listInbox(mailbox: string, sinceIso: string, max = 100): Promise<MailSummary[]> {
  const select = "id,subject,from,receivedDateTime,hasAttachments,bodyPreview,webLink,internetMessageId";
  let url: string | null =
    `${mbx(mailbox)}/mailFolders/inbox/messages?$filter=receivedDateTime ge ${sinceIso}` +
    `&$orderby=receivedDateTime desc&$top=50&$select=${select}`;
  const out: MailSummary[] = [];
  while (url && out.length < max) {
    const json = await (await graph(url)).json();
    for (const m of json.value ?? []) {
      out.push({
        id: m.id,
        subject: m.subject ?? "",
        from: m.from?.emailAddress?.address ?? "",
        fromName: m.from?.emailAddress?.name ?? "",
        receivedDateTime: m.receivedDateTime,
        hasAttachments: !!m.hasAttachments,
        bodyPreview: m.bodyPreview ?? "",
        webLink: m.webLink ?? "",
        internetMessageId: m.internetMessageId ?? "",
      });
    }
    url = json["@odata.nextLink"] ?? null;
  }
  return out.slice(0, max);
}

export async function getBodyText(mailbox: string, id: string): Promise<string> {
  const res = await graph(`${mbx(mailbox)}/messages/${id}?$select=body`, {
    headers: { Prefer: 'outlook.body-content-type="text"' },
  });
  const json = await res.json();
  return (json.body?.content ?? "").slice(0, 20000);
}

export interface PdfAttachment { name: string; base64: string }

/** PDF file attachments up to 15 MB each (Claude reads PDFs directly). */
export async function getPdfAttachments(mailbox: string, id: string): Promise<{ pdfs: PdfAttachment[]; otherNames: string[] }> {
  const json = await (await graph(`${mbx(mailbox)}/messages/${id}/attachments`)).json();
  const pdfs: PdfAttachment[] = [];
  const otherNames: string[] = [];
  for (const a of json.value ?? []) {
    const isFile = a["@odata.type"] === "#microsoft.graph.fileAttachment";
    const isPdf = isFile && (a.contentType === "application/pdf" || /\.pdf$/i.test(a.name ?? ""));
    if (isPdf && a.contentBytes && (a.size ?? 0) <= 15 * 1024 * 1024) pdfs.push({ name: a.name, base64: a.contentBytes });
    else if (!a.isInline) otherNames.push(a.name ?? "attachment");
  }
  return { pdfs, otherNames };
}

/** Message ids (any folder) whose text mentions the term, newest first. */
export async function searchMailbox(mailbox: string, term: string): Promise<{ id: string; subject: string; folderHint: string }[]> {
  const q = encodeURIComponent(`"${term.replace(/"/g, "")}"`);
  const json = await (await graph(`${mbx(mailbox)}/messages?$search=${q}&$top=10&$select=id,subject,parentFolderId`)).json();
  return (json.value ?? []).map((m: { id: string; subject?: string; parentFolderId?: string }) => ({
    id: m.id, subject: m.subject ?? "", folderHint: m.parentFolderId ?? "",
  }));
}

export async function sendHtmlMail(fromMailbox: string, to: string[], subject: string, html: string): Promise<void> {
  await graph(`${mbx(fromMailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: to.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
}

/** Forward an email with its attachments (Graph keeps attachments on forward). */
export async function forwardMessage(mailbox: string, id: string, to: string, comment: string): Promise<void> {
  await graph(`${mbx(mailbox)}/messages/${id}/forward`, {
    method: "POST",
    body: JSON.stringify({ comment, toRecipients: [{ emailAddress: { address: to } }] }),
  });
}

// Microsoft Graph sender — the fallback for DigitalOcean's outbound SMTP block.
//
// DO blocks ports 587 and 465 account-wide (verified 2026-08-26 and again
// 2026-09-01: every smtp-mail.outlook.com IP times out, while 443 to
// graph.microsoft.com connects fine). Graph's sendMail rides HTTPS 443, so it
// sidesteps the block entirely while still sending from the same Microsoft
// mailbox — no third-party email vendor, per the standing decision.
//
// Auth is the client-credentials flow (app-only, no user present), so this
// needs an Azure app registration on the safeharborcp.com tenant with the
// APPLICATION permission Mail.Send, admin-consented. Note that Mail.Send
// app-only grants send-as for ANY mailbox in the tenant unless scoped down
// with an ApplicationAccessPolicy — worth doing, and noted in the docs.
//
// Env:
//   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET   (required)
//   REPORT_SMTP_USER  — reused as the sending mailbox address

const TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Graph rejects a sendMail request whose total body exceeds ~4MB; base64
// inflates by ~4/3. Stay well under and fail with a clear message rather than
// letting Graph return an opaque 413.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export interface GraphAttachment {
  filename: string;
  content: string;
  contentType?: string;
}

export interface GraphMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
  attachments?: GraphAttachment[];
}

function requireEnv(): { tenant: string; clientId: string; secret: string } {
  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  const missing = [
    !tenant && 'GRAPH_TENANT_ID',
    !clientId && 'GRAPH_CLIENT_ID',
    !secret && 'GRAPH_CLIENT_SECRET',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Microsoft Graph is not configured — missing ${missing.join(', ')} in /opt/amo-dashboard/.env. ` +
      `These come from the Azure app registration (Overview tab for tenant/client id, ` +
      `Certificates & secrets for the value).`
    );
  }
  return { tenant: tenant!, clientId: clientId!, secret: secret! };
}

/** Acquire an app-only access token. Throws with Azure's own error text on failure. */
export async function getGraphToken(): Promise<string> {
  const { tenant, clientId, secret } = requireEnv();
  const res = await fetch(`${TOKEN_HOST}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const body = await res.json().catch(() => ({}) as any);
  if (!res.ok) {
    // Azure puts the actionable detail in error_description, not the HTTP status.
    throw new Error(
      `Graph token request failed (${res.status}): ${body.error_description || body.error || 'no detail'}`
    );
  }
  if (!body.access_token) throw new Error('Graph token response contained no access_token');
  return body.access_token as string;
}

/**
 * Confirm credentials and mailbox access WITHOUT sending anything — acquires a
 * token, then reads the sending mailbox. Lets the Azure setup be validated
 * before any mail reaches a real recipient.
 */
export async function verifyGraphAccess(sender: string): Promise<string> {
  const token = await getGraphToken();
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(sender)}?$select=mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}) as any);
  if (!res.ok) {
    const detail = body?.error?.message || 'no detail';
    if (res.status === 403) {
      throw new Error(
        `Token works but Graph refused the mailbox read (403): ${detail}. ` +
        `Usually means the app registration lacks admin-consented APPLICATION permissions ` +
        `(User.Read.All for this check, Mail.Send to send).`
      );
    }
    if (res.status === 404) {
      throw new Error(`Mailbox ${sender} not found in this tenant (404): ${detail}`);
    }
    throw new Error(`Graph mailbox check failed (${res.status}): ${detail}`);
  }
  return (body.mail || body.userPrincipalName || sender) as string;
}

/** Send one message as `from`. Resolves to nothing — Graph's sendMail returns 202 with no body. */
export async function sendViaGraph(msg: GraphMessage): Promise<void> {
  const token = await getGraphToken();

  const attachments = (msg.attachments || []).map(a => {
    const bytes = Buffer.from(a.content, 'utf8');
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment ${a.filename} is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit for a single Graph sendMail request. ` +
        `Trim the report window or switch to an upload session.`
      );
    }
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType || 'text/csv',
      contentBytes: bytes.toString('base64'),
    };
  });

  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(msg.from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: msg.subject,
        body: { contentType: 'HTML', content: msg.html },
        toRecipients: msg.to.map(address => ({ emailAddress: { address } })),
        attachments,
      },
      saveToSentItems: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try { detail = JSON.parse(text)?.error?.message || text; } catch { /* keep raw text */ }
    if (res.status === 403) {
      throw new Error(
        `Graph refused the send (403): ${detail}. Check that Mail.Send is granted as an ` +
        `APPLICATION permission and admin-consented, and that any ApplicationAccessPolicy ` +
        `includes ${msg.from}.`
      );
    }
    throw new Error(`Graph sendMail failed (${res.status}): ${detail}`);
  }
}

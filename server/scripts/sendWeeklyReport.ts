// Weekly emailed report — the AMO Market Monitor roll-up: the same market over
// three horizons (last 15 days, last 30 days, last 360 days), each against the
// period just before it, with Miami-Dade and Broward held apart throughout.
//
// Replaced the single rolling 15-day summary on 21 Sep 2026, at the owner's
// request (19 Sep): "activity in roll-up last 15 days, last month, and the last
// 360 days … with charts so they can see changes from those time frames."
// server/email/report.ts still holds the old 15-day builder, unused, until the
// roll-up has sent cleanly a few times.
//
// Usage:
//   tsx server/scripts/sendWeeklyReport.ts             preview only, writes local files, sends nothing
//   tsx server/scripts/sendWeeklyReport.ts --check     verify Graph credentials only, sends nothing
//   tsx server/scripts/sendWeeklyReport.ts --send      actually sends
//
// TRANSPORT: defaults to Microsoft Graph (HTTPS 443) when GRAPH_CLIENT_ID is set, because
// DigitalOcean blocks outbound SMTP account-wide from this droplet (ports 587/465 time out;
// re-verified 2026-09-01). Force either path with REPORT_TRANSPORT=graph|smtp.
//
// Env (only required for --send):
//   graph: GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET
//   smtp:  REPORT_SMTP_PASS (Outlook app password)
//   both:  REPORT_SMTP_USER (sending mailbox), REPORT_RECIPIENTS (comma-separated)
// REPORT_SEND_DATE (YYYY-MM-DD) pins the as-of date, for regenerating a past report.
// Each county's windows still end on its own latest recorded date, so a DB that
// lags today renders a full report rather than an empty one.
import fs from 'fs';
import path from 'path';
import { format } from 'date-fns';
import { getDb } from '../db';
import { buildRollupReport } from '../email/rollupReport';
import { createReportTransport } from '../email/mailer';
import { sendViaGraph, verifyGraphAccess } from '../email/graphMailer';

const SEND = process.argv.includes('--send');
const CHECK = process.argv.includes('--check');
const SENDER = process.env.REPORT_SMTP_USER || 'mktinfo@safeharborcp.com';
const RECIPIENTS = (process.env.REPORT_RECIPIENTS || 'andres@safeharborcp.com,david@safeharborcp.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const TRANSPORT = (process.env.REPORT_TRANSPORT || (process.env.GRAPH_CLIENT_ID ? 'graph' : 'smtp')).toLowerCase();

async function main() {
  // Credential check runs before any report work — it exists to validate the
  // Azure setup without putting mail in front of a real recipient.
  if (CHECK) {
    console.log(`Transport: ${TRANSPORT}`);
    if (TRANSPORT !== 'graph') {
      console.log('--check only applies to the Graph transport. Set GRAPH_CLIENT_ID or REPORT_TRANSPORT=graph.');
      return;
    }
    const mailbox = await verifyGraphAccess(SENDER);
    console.log(`✅ Graph credentials work and mailbox ${mailbox} is reachable. Nothing was sent.`);
    console.log('Next: a --send run with REPORT_RECIPIENTS set to your own address.');
    return;
  }

  const sendDate = process.env.REPORT_SEND_DATE || format(new Date(), 'yyyy-MM-dd');

  const db = getDb();
  const report = buildRollupReport(db, sendDate);
  const subject = report.subject;
  const coverage = Object.entries(report.asOf)
    .map(([c, d]) => `${c} through ${d}`).join(', ') || 'no data';

  if (!SEND) {
    const outDir = path.resolve(process.cwd(), 'server/scripts/output');
    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(outDir, `report-preview-${sendDate}.html`);
    const cleanCsvPath = path.join(outDir, `clean-events-${sendDate}.csv`);
    const facilityCsvPath = path.join(outDir, `lending-relationships-${sendDate}.csv`);
    fs.writeFileSync(htmlPath, report.html);
    fs.writeFileSync(cleanCsvPath, report.cleanCsv);
    fs.writeFileSync(facilityCsvPath, report.facilityCsv);

    console.log('PREVIEW ONLY — nothing was sent.');
    console.log(`Subject: ${subject}`);
    console.log(`From:    "AMO Dashboard" <${SENDER}>`);
    console.log(`To:      ${RECIPIENTS.join(', ')}`);
    console.log(`Data through: ${coverage}`);
    console.log(`Transfers (last 15 days): ${report.cleanCount}`);
    console.log(`Lending relationships:    ${report.facilityCount}`);
    console.log('Files written:');
    console.log(`  ${htmlPath}`);
    console.log(`  ${cleanCsvPath}`);
    console.log(`  ${facilityCsvPath}`);
    console.log('\nRun again with --send once the preview looks right.');
    return;
  }

  // Refuse to email an empty report. normalize.py empties aom_events_clean and
  // refills it in place over roughly 90 minutes, and the Friday run that sends
  // this overlaps the 08:30 nightly rebuild (Friday runs have finished between
  // 09:00 and 10:05). A report built mid-rebuild reads zero transfers and would
  // go out looking like a dead market. Any real 15-day window has hundreds, so
  // zero means "the table is being rebuilt", never "nothing happened".
  //
  // buildRollupReport returns cleanCount 0 for both shapes of empty: a table
  // with no rows at all, and one whose rows all fall outside the window.
  if (report.cleanCount === 0) {
    console.error(`NOT SENT: 0 transfers as of ${sendDate} (${coverage}) — the table is most likely mid-rebuild. Retry later.`);
    process.exitCode = 2;
    return;
  }

  const attachments = [
    { filename: `clean-events-${sendDate}.csv`, content: report.cleanCsv },
    { filename: `lending-relationships-${sendDate}.csv`, content: report.facilityCsv },
  ];

  if (TRANSPORT === 'graph') {
    await sendViaGraph({ from: SENDER, to: RECIPIENTS, subject, html: report.html, attachments });
    console.log(`Sent via Microsoft Graph to ${RECIPIENTS.join(', ')}`);
    return;
  }

  const transport = createReportTransport();
  const info = await transport.sendMail({
    from: `"AMO Dashboard" <${SENDER}>`,
    to: RECIPIENTS.join(', '),
    subject,
    html: report.html,
    attachments,
  });
  console.log(`Sent via SMTP to ${RECIPIENTS.join(', ')} — messageId ${info.messageId}`);
}

main().catch(err => {
  console.error('Weekly report failed:', err);
  process.exit(1);
});

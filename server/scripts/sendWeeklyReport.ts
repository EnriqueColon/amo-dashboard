// Weekly emailed report — clean AMO events + lending relationships, rolling 15-day window.
//
// Usage:
//   tsx server/scripts/sendWeeklyReport.ts            preview only, writes local files, sends nothing
//   tsx server/scripts/sendWeeklyReport.ts --send      actually sends via Outlook SMTP
//
// Env (only required for --send): REPORT_SMTP_USER, REPORT_SMTP_PASS (Outlook app password),
// REPORT_RECIPIENTS (comma-separated). See CLAUDE.md for the droplet cron wiring.
// REPORT_START_DATE / REPORT_END_DATE (YYYY-MM-DD) override the rolling 15-day window —
// useful for previewing against a dev DB whose data lags today, or regenerating a past week.
import fs from 'fs';
import path from 'path';
import { subDays, format } from 'date-fns';
import { getDb } from '../db';
import { buildWeeklyReport } from '../email/report';
import { createReportTransport } from '../email/mailer';

const SEND = process.argv.includes('--send');
const SENDER = process.env.REPORT_SMTP_USER || 'mktinfo@safeharborcp.com';
const RECIPIENTS = (process.env.REPORT_RECIPIENTS || 'andres@safeharborcp.com,david@safeharborcp.com')
  .split(',').map(s => s.trim()).filter(Boolean);

async function main() {
  const endDate = process.env.REPORT_END_DATE || format(new Date(), 'yyyy-MM-dd');
  const startDate = process.env.REPORT_START_DATE || format(subDays(new Date(endDate), 15), 'yyyy-MM-dd');

  const db = getDb();
  const report = buildWeeklyReport(db, startDate, endDate);
  const subject = `AMO Dashboard — ${startDate} to ${endDate} Activity Report`;

  if (!SEND) {
    const outDir = path.resolve(process.cwd(), 'server/scripts/output');
    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(outDir, `report-preview-${endDate}.html`);
    const cleanCsvPath = path.join(outDir, `clean-events-${endDate}.csv`);
    const facilityCsvPath = path.join(outDir, `lending-relationships-${endDate}.csv`);
    fs.writeFileSync(htmlPath, report.html);
    fs.writeFileSync(cleanCsvPath, report.cleanCsv);
    fs.writeFileSync(facilityCsvPath, report.facilityCsv);

    console.log('PREVIEW ONLY — nothing was sent.');
    console.log(`Subject: ${subject}`);
    console.log(`From:    "AMO Dashboard" <${SENDER}>`);
    console.log(`To:      ${RECIPIENTS.join(', ')}`);
    console.log(`Clean AMO events:     ${report.cleanCount} rows`);
    console.log(`Lending relationships: ${report.facilityCount} rows`);
    console.log('Files written:');
    console.log(`  ${htmlPath}`);
    console.log(`  ${cleanCsvPath}`);
    console.log(`  ${facilityCsvPath}`);
    console.log('\nRun again with --send once the preview looks right.');
    return;
  }

  const transport = createReportTransport();
  const info = await transport.sendMail({
    from: `"AMO Dashboard" <${SENDER}>`,
    to: RECIPIENTS.join(', '),
    subject,
    html: report.html,
    attachments: [
      { filename: `clean-events-${endDate}.csv`, content: report.cleanCsv },
      { filename: `lending-relationships-${endDate}.csv`, content: report.facilityCsv },
    ],
  });
  console.log(`Sent to ${RECIPIENTS.join(', ')} — messageId ${info.messageId}`);
}

main().catch(err => {
  console.error('Weekly report failed:', err);
  process.exit(1);
});

// Preview-only renderer for the roll-up email. Builds the HTML and writes it to
// server/scripts/output — sends nothing, touches no mailbox.
//
//   AMO_DB_PATH=../prod_snapshot.db tsx server/scripts/previewRollup.ts
//
// REPORT_SEND_DATE (YYYY-MM-DD) pins the "as of" date; it defaults to today.
// Each county's windows still end on its own latest recorded date, so a DB that
// lags today still renders a full report.
import fs from 'fs';
import path from 'path';
import { format } from 'date-fns';
import { getDb } from '../db';
import { buildRollupReport } from '../email/rollupReport';

const sendDate = process.env.REPORT_SEND_DATE || format(new Date(), 'yyyy-MM-dd');
const report = buildRollupReport(getDb(), sendDate);

const outDir = path.resolve(process.cwd(), 'server/scripts/output');
fs.mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, `rollup-preview-${sendDate}.html`);
fs.writeFileSync(htmlPath, report.html);

console.log('PREVIEW ONLY — nothing was sent.');
console.log(`Subject: ${report.subject}`);
console.log(`Data through: ${JSON.stringify(report.asOf)}`);
console.log(`Transfers (15d): ${report.cleanCount}   Lending relationships: ${report.facilityCount}`);
console.log(htmlPath);

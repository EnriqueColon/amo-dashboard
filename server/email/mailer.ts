import nodemailer from 'nodemailer';

export function createReportTransport() {
  const host = process.env.REPORT_SMTP_HOST || 'smtp-mail.outlook.com';
  const port = Number(process.env.REPORT_SMTP_PORT || 587);
  const user = process.env.REPORT_SMTP_USER || 'mktinfo@safeharborcp.com';
  const pass = process.env.REPORT_SMTP_PASS;
  if (!pass) {
    throw new Error('REPORT_SMTP_PASS is not set — add the Outlook app password for ' + user + ' to .env');
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: false, // STARTTLS on 587
    auth: { user, pass },
  });
}

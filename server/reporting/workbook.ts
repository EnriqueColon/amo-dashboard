import ExcelJS from 'exceljs';

// Builds the two-sheet "Download report" workbook for the Reporting tab:
//   1. Summary — title block, report parameters, per-entity summary statistics
//      (or top-participant tables when no entities are selected), with column
//      totals that tie out to the detail sheet.
//   2. Transaction Detail — every filing in the filter set, one row per filing,
//      styled header, frozen pane, autofilter, CFN hyperlinked to the county
//      document image where available.
// Sheet order is deliberate (summary first, detail behind it) — standard
// reporting convention: the reader lands on the answer, the evidence follows.

const NAVY = 'FF1F3864';
const LIGHT_FILL = 'FFF2F5FA';
const BORDER_GRAY = 'FFD9D9D9';
const MUTED = 'FF6B7280';
const MONEY_FMT = '"$"#,##0';
const INT_FMT = '#,##0';

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: BORDER_GRAY } },
  left: { style: 'thin', color: { argb: BORDER_GRAY } },
  bottom: { style: 'thin', color: { argb: BORDER_GRAY } },
  right: { style: 'thin', color: { argb: BORDER_GRAY } },
};

function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle', wrapText: false };
    cell.border = thinBorder;
  });
  row.height = 18;
}

export interface ReportMeta {
  countyLabel: string;
  startDate: string;
  endDate: string;
  direction: '' | 'assignor' | 'assignee';
  search: string;
  reviewed: string;
  targetsOnly: boolean;
  entities: string[];               // the selection, in the order chosen
  entityTypes: Map<string, string>; // canonical name → entity_type
  docLink: (r: any) => string;
}

const DIRECTION_LABEL: Record<string, string> = {
  '': 'All activity (sold and acquired)',
  assignor: 'Sold / assigned out only',
  assignee: 'Acquired only',
};

export function buildActivityWorkbook(rows: any[], meta: ReportMeta): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AMO Tracker';
  wb.created = new Date();

  buildSummarySheet(wb, rows, meta);
  buildDetailSheet(wb, rows, meta);
  return wb;
}

// ── Sheet 1: Summary ─────────────────────────────────────────────────────────
function buildSummarySheet(wb: ExcelJS.Workbook, rows: any[], meta: ReportMeta) {
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.columns = [
    { width: 42 }, { width: 14 }, { width: 13 }, { width: 15 }, { width: 15 },
    { width: 10 }, { width: 17 }, { width: 13 }, { width: 13 }, { width: 34 },
  ];

  // Title block
  const title = ws.getCell('A1');
  title.value = 'AMO Tracker — Entity Activity Report';
  title.font = { bold: true, size: 16, color: { argb: NAVY } };
  ws.getCell('A2').value = 'Assignment-of-mortgage filings · public county records';
  ws.getCell('A2').font = { size: 10, color: { argb: MUTED } };

  const metaPairs: Array<[string, string]> = [
    ['Scope', meta.countyLabel],
    ['Period', meta.startDate || meta.endDate
      ? `${meta.startDate || 'beginning of record'} to ${meta.endDate || 'present'}`
      : 'All dates on record'],
    ['Direction', DIRECTION_LABEL[meta.direction]],
    ['Other filters', [
      meta.search ? `search "${meta.search}"` : '',
      meta.reviewed === 'yes' ? 'reviewed only' : meta.reviewed === 'no' ? 'pending review only' : '',
      meta.targetsOnly ? 'targets watchlist only' : '',
    ].filter(Boolean).join(' · ') || 'None'],
    ['Generated', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
  ];
  let r = 4;
  for (const [label, value] of metaPairs) {
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 1).font = { bold: true, size: 10, color: { argb: MUTED } };
    ws.getCell(r, 2).value = value;
    ws.getCell(r, 2).font = { size: 10 };
    ws.mergeCells(r, 2, r, 7);
    r++;
  }
  r++;

  if (meta.entities.length > 0) {
    r = entitySummaryTable(ws, rows, meta, r);
  } else {
    r = marketSummaryTables(ws, rows, r);
  }

  // Footnotes
  r++;
  const notes = [
    '$ volume sums the underlying loan amount where the recorded document states one; many filings state none, so it is a floor, not a total.',
    `Transaction Detail sheet contains ${rows.length.toLocaleString('en-US')} filings — the evidence for every figure above.`,
  ];
  if (meta.entities.length > 0) {
    notes.splice(1, 0,
      'A filing between two selected entities appears once in the detail sheet but is attributed to each side above, so column totals can exceed distinct filings.');
  }
  for (const note of notes) {
    ws.getCell(r, 1).value = `• ${note}`;
    ws.getCell(r, 1).font = { size: 9, italic: true, color: { argb: MUTED } };
    ws.mergeCells(r, 1, r, 10);
    r++;
  }
}

function entitySummaryTable(ws: ExcelJS.Worksheet, rows: any[], meta: ReportMeta, startRow: number): number {
  const section = ws.getCell(startRow, 1);
  section.value = 'Summary statistics — entities of interest';
  section.font = { bold: true, size: 12, color: { argb: NAVY } };
  let r = startRow + 1;

  const header = ws.getRow(r);
  header.values = ['Entity', 'Type', 'Total filings', 'Sold (assignor)', 'Acquired (assignee)', 'Net', '$ Volume (known)', 'First activity', 'Last activity', 'Top counterparty'];
  styleHeaderRow(header);
  r++;

  const totals = { filings: 0, sold: 0, acquired: 0, dollars: 0 };
  meta.entities.forEach((entity, i) => {
    let sold = 0, acquired = 0, dollars = 0;
    let first: string | null = null, last: string | null = null;
    const counterparties = new Map<string, number>();
    for (const row of rows) {
      const isSeller = row.assignor === entity;
      const isBuyer = row.assignee === entity;
      if (!isSeller && !isBuyer) continue;
      if (isSeller) { sold++; bump(counterparties, row.assignee); }
      if (isBuyer) { acquired++; bump(counterparties, row.assignor); }
      if (row.loan_amount > 0) dollars += row.loan_amount;
      if (!first || row.rec_date < first) first = row.rec_date;
      if (!last || row.rec_date > last) last = row.rec_date;
    }
    const topCp = Array.from(counterparties.entries()).sort((a, b) => b[1] - a[1])[0];
    const filings = sold + acquired;
    totals.filings += filings; totals.sold += sold; totals.acquired += acquired; totals.dollars += dollars;

    const row = ws.getRow(r);
    row.values = [
      entity, meta.entityTypes.get(entity) || '—', filings, sold, acquired,
      acquired - sold, dollars || null, first || '—', last || '—',
      topCp ? `${topCp[0]} (${topCp[1]})` : '—',
    ];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col > 10) return;
      cell.border = thinBorder;
      cell.font = { size: 10 };
      if (col >= 3 && col <= 6) cell.numFmt = INT_FMT;
      if (col === 7) cell.numFmt = MONEY_FMT;
    });
    if (i % 2 === 1) {
      for (let c = 1; c <= 10; c++) {
        ws.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_FILL } };
      }
    }
    // Zero-activity entities are the finding, not noise — mute them, keep them.
    if (filings === 0) {
      row.getCell(1).font = { size: 10, color: { argb: MUTED }, italic: true };
    }
    r++;
  });

  const totalRow = ws.getRow(r);
  totalRow.values = ['Total', '', totals.filings, totals.sold, totals.acquired,
    totals.acquired - totals.sold, totals.dollars || null, '', '', ''];
  totalRow.eachCell({ includeEmpty: true }, (cell, col) => {
    if (col > 10) return;
    cell.font = { bold: true, size: 10 };
    cell.border = { ...thinBorder, top: { style: 'double', color: { argb: NAVY } } };
    if (col >= 3 && col <= 6) cell.numFmt = INT_FMT;
    if (col === 7) cell.numFmt = MONEY_FMT;
  });
  r++;

  const distinct = ws.getCell(r, 1);
  distinct.value = `Distinct filings across the selection: ${rows.length.toLocaleString('en-US')}`;
  distinct.font = { size: 10, bold: true, color: { argb: MUTED } };
  ws.mergeCells(r, 1, r, 7);
  return r + 1;
}

function marketSummaryTables(ws: ExcelJS.Worksheet, rows: any[], startRow: number): number {
  // No entity selection: summarize the filtered market instead.
  const sellers = new Map<string, { n: number; dollars: number }>();
  const buyers = new Map<string, { n: number; dollars: number }>();
  for (const row of rows) {
    if (row.assignor) bumpAgg(sellers, row.assignor, row.loan_amount);
    if (row.assignee) bumpAgg(buyers, row.assignee, row.loan_amount);
  }

  let r = startRow;
  for (const [label, map] of [['Top sellers (assignors)', sellers], ['Top acquirers (assignees)', buyers]] as const) {
    const section = ws.getCell(r, 1);
    section.value = label;
    section.font = { bold: true, size: 12, color: { argb: NAVY } };
    r++;
    const header = ws.getRow(r);
    header.values = ['Entity', '', 'Filings', '', '', '', '$ Volume (known)'];
    styleHeaderRow(header);
    r++;
    const top = Array.from(map.entries()).sort((a, b) => b[1].n - a[1].n).slice(0, 15);
    for (const [entity, agg] of top) {
      const row = ws.getRow(r);
      row.values = [entity, '', agg.n, '', '', '', agg.dollars || null];
      row.getCell(1).font = { size: 10 };
      row.getCell(3).numFmt = INT_FMT;
      row.getCell(7).numFmt = MONEY_FMT;
      for (const c of [1, 3, 7]) ws.getCell(r, c).border = thinBorder;
      r++;
    }
    r++;
  }
  return r;
}

function bump(map: Map<string, number>, key: string | null) {
  if (!key || key === 'UNKNOWN') return;
  map.set(key, (map.get(key) || 0) + 1);
}
function bumpAgg(map: Map<string, { n: number; dollars: number }>, key: string, loanAmount: any) {
  const agg = map.get(key) || { n: 0, dollars: 0 };
  agg.n++;
  if (loanAmount > 0) agg.dollars += loanAmount;
  map.set(key, agg);
}

// ── Sheet 2: Transaction Detail ──────────────────────────────────────────────
const DETAIL_COLUMNS: Array<{ header: string; key: string; width: number; money?: boolean }> = [
  { header: 'CFN', key: 'cfn', width: 14 },
  { header: 'Date', key: 'rec_date', width: 11 },
  { header: 'County', key: 'county', width: 12 },
  { header: 'Doc Type', key: 'doc_type', width: 24 },
  { header: 'Category', key: 'doc_category', width: 15 },
  { header: 'Title', key: 'doc_title', width: 28 },
  { header: 'Assignor', key: 'assignor', width: 32 },
  { header: 'Assignee', key: 'assignee', width: 32 },
  { header: 'Assignor Type', key: 'assignor_type', width: 13 },
  { header: 'Assignee Type', key: 'assignee_type', width: 13 },
  { header: 'Txn Type', key: 'txn_type', width: 16 },
  { header: 'Property Address', key: 'property_address', width: 32 },
  { header: 'Folio / Parcel', key: 'folio_parcel', width: 16 },
  { header: 'Loan Amount', key: 'loan_amount', width: 14, money: true },
  { header: 'Consideration', key: 'consideration_amount', width: 14, money: true },
  { header: 'Signatory Officer', key: 'signatory_officer', width: 24 },
  { header: 'Book', key: 'rec_book', width: 8 },
  { header: 'Page', key: 'rec_page', width: 8 },
  { header: 'Classification', key: 'classification', width: 16 },
  { header: 'Reviewed By', key: 'reviewed_by', width: 12 },
  { header: 'Reviewed At', key: 'reviewed_at', width: 18 },
];

function buildDetailSheet(wb: ExcelJS.Workbook, rows: any[], meta: ReportMeta) {
  const ws = wb.addWorksheet('Transaction Detail', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = DETAIL_COLUMNS.map(c => ({ key: c.key, width: c.width }));

  const header = ws.getRow(1);
  header.values = DETAIL_COLUMNS.map(c => c.header);
  styleHeaderRow(header);

  for (const r of rows) {
    const row = ws.addRow(DETAIL_COLUMNS.map(c => {
      const v = r[c.key];
      if (c.money) return v > 0 ? v : null;
      return v ?? null;
    }));
    row.eachCell({ includeEmpty: false }, cell => { cell.font = { size: 10 }; });
    const link = meta.docLink(r);
    if (link) {
      const cfnCell = row.getCell(1);
      cfnCell.value = { text: r.cfn, hyperlink: link };
      cfnCell.font = { size: 10, color: { argb: 'FF2563EB' }, underline: true };
    }
    DETAIL_COLUMNS.forEach((c, i) => {
      if (c.money) row.getCell(i + 1).numFmt = MONEY_FMT;
    });
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: DETAIL_COLUMNS.length } };
}

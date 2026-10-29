import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the Market Research page. Keys are namespaced "research:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'research:Date': {
    definition: 'The publication date the publisher states, to the month where that is all it gives. For uploaded reports, the date read from the document\'s first pages, or blank.',
    whyValuable: 'Research houses publish on a quarterly cadence; the date says which quarter a figure describes.',
  },
  'research:Report': {
    definition: 'The publication\'s title, linked to the publisher\'s page, with the two-sentence summary the sweep recorded. Expand the row for the key findings.',
    howCalculated: 'Found each morning by OpenAI web search run once per publisher (Trepp, CBRE, JLL, Cushman & Wakefield, Colliers, Marcus & Millichap, MBA, Moody\'s, Newmark, Avison Young, CoStar, NAIOP, Green Street, Walker & Dunlop), limited to the past 90 days and de-duplicated by title.',
    whyValuable: 'Tick reports to write a market memo from them; only what the reports say goes into it.',
  },
  'research:Publisher': {
    definition: 'The research house that published it.',
    whyValuable: 'Each publisher has a lane: Trepp for CMBS distress, MBA for originations and delinquency, Green Street for pricing.',
  },
  'research:Topic': {
    definition: 'One of ten subjects assigned when the report was found: Distressed/CMBS, Capital Markets, Office, Multifamily, Retail, Industrial, Market Outlook, Florida/Southeast, Banking/Lending, Investment Sales.',
    whyValuable: 'Florida/Southeast and Distressed/CMBS are listed first because they bear most directly on the firm\'s sourcing.',
  },
  'research:Found': {
    definition: 'When the daily sweep last saw this publication. Reports leave the archive a year after they were last found.',
    whyValuable: 'A report found again today is still current on the publisher\'s site.',
  },
  'research:Producer': {
    definition: 'The firm that produced an uploaded report, read from the document (CBRE, JLL, Cushman & Wakefield, Colliers, MBA, NAIOP, ULI, …) or guessed from the filename; "unknown" when neither says.',
    whyValuable: 'Filter the library by producer.',
  },
  'research:Summary': {
    definition: 'Whether an OpenAI summary of the uploaded report exists. Summarise reads the PDF text (with OCR for scanned pages) and writes an executive summary and key takeaways; View opens it.',
    howCalculated: 'Text extracted with pdftotext, OCR for up to three scanned pages; when the text is too thin, the file itself is given to the model.',
    whyValuable: 'A summary is written once and kept, so the second reader pays nothing.',
  },
  'research:Actions': {
    definition: 'Open shows the PDF in the browser, Download saves it, Summarise or View handles the summary, Delete removes the report and its file.',
    whyValuable: 'Anyone signed in can upload, summarise and delete: there is no separate admin token here.',
  },
}

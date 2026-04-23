import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type MetricDefRich = {
  definition: string
  howCalculated?: string
  whyValuable?: string
}

export type MetricDef = string | MetricDefRich

export const METRIC_DEFINITIONS: Record<string, MetricDef> = {
  Institution: { definition: "FDIC-insured bank or institution name.", whyValuable: "Identifies the bank for comparison and screening." },
  State: { definition: "State where the institution is chartered.", whyValuable: "Enables geographic filtering and regional analysis." },
  Report: { definition: "FDIC report date (quarter).", whyValuable: "Indicates data vintage for time-series comparison." },
  "Total Assets": { definition: "Total assets for the latest quarter (in dollars).", howCalculated: "Sum of all assets from FDIC Call Report (Schedule RC).", whyValuable: "Scales institution size for peer comparison and exposure analysis." },
  "Total Loans": { definition: "Net loans and leases (in dollars). FDIC LNLSNET.", howCalculated: "Total loans and leases net of unearned income (FDIC LNLSNET, thousands × 1000).", whyValuable: "Dollar value of loan book; used as denominator for NPL ratio and reserve coverage." },
  "CRE Concentration": { definition: "CRE loans as a share of total loans.", howCalculated: "CRE loans ÷ total loans × 100.", whyValuable: "Flags banks with elevated commercial real estate exposure relative to loan book size." },
  "NPL ($)": { definition: "Dollar amount of nonaccrual loans and leases.", howCalculated: "FDIC NALNLS (nonaccrual loans, thousands × 1000).", whyValuable: "Absolute dollar exposure to nonperforming loans; complements NPL ratio for sizing credit stress." },
  "NPL Ratio": { definition: "Nonaccrual loans and leases as a share of total loans and leases.", howCalculated: "Nonaccrual loans ÷ total loans × 100.", whyValuable: "Measures current credit stress; rising NPL suggests deteriorating loan quality." },
  "CRE Loans": { definition: "Total commercial real estate loans (dollars).", howCalculated: "Sum of construction, multifamily, non-residential, and other real estate loans.", whyValuable: "Absolute CRE exposure; used as denominator for CRE concentration and earnings buffer." },
  "ROA": { definition: "Return on assets. Net income as a share of total assets.", howCalculated: "Net income ÷ total assets × 100 (FDIC ROA).", whyValuable: "Profitability per dollar of assets; low or negative ROA weakens loss-absorption capacity." },
  "NIM": { definition: "Net interest margin. Core spread on lending.", howCalculated: "Net interest income ÷ average earning assets × 100 (FDIC NIMR).", whyValuable: "Compressed NIM limits earnings capacity; declining NIM suggests margin pressure." },
  "Noncurrent / Loans": { definition: "Noncurrent loans and leases as a percent of gross loans and leases (FDIC NCLNLSR). Past due 90+ plus nonaccrual.", howCalculated: "Past due 90+ days plus nonaccrual ÷ gross loans × 100.", whyValuable: "True NPL ratio; anchors credit stress to the loan book." },
  "Past Due 30-89 / Assets": { definition: "Loans past due 30–89 days as a percent of total assets (FDIC P3ASSET).", howCalculated: "Past due 30–89 days ÷ total assets × 100.", whyValuable: "Early delinquency indicator; rising values may precede noncurrent migration." },
  "Past Due 90+ / Assets": { definition: "Loans past due 90+ days as a percent of total assets (FDIC P9ASSET).", howCalculated: "Past due 90+ days ÷ total assets × 100.", whyValuable: "Part of noncurrent definition; elevated values signal credit stress." },
  "Noncurrent ($)": { definition: "Dollar amount of noncurrent loans and leases (past due 90+ plus nonaccrual).", howCalculated: "Derived: Noncurrent / Loans ratio × Total loans.", whyValuable: "Absolute dollar exposure; complements NPL ($) which is nonaccrual only." },
  "Reserve Coverage": { definition: "Loan loss allowance as a share of total loans.", howCalculated: "Allowance for loan and lease losses ÷ total loans × 100 (FDIC LNLSDEPR).", whyValuable: "Indicates cushion for future losses; thin reserves relative to NPLs signal vulnerability." },
  CET1: { definition: "Common Equity Tier 1 capital ratio.", howCalculated: "CET1 capital ÷ risk-weighted assets × 100 (FDIC RBCT1CER).", whyValuable: "Core measure of loss-absorbing capacity; regulatory minimum is 4.5%." },
  Leverage: { definition: "Leverage ratio (PCA).", howCalculated: "Tier 1 capital ÷ average total consolidated assets × 100 (FDIC RBC1AAJ).", whyValuable: "Simpler capital measure; used when CET1 is unavailable." },
  "Capital Used": { definition: "The capital ratio used: CET1 when available; otherwise Leverage.", howCalculated: "CET1 if reported; else Leverage ratio.", whyValuable: "Ensures consistent capital comparison across institutions with different reporting." },
  "CRE / (T1+T2)": { definition: "Commercial real estate loans divided by Tier 1 + Tier 2 capital.", howCalculated: "CRE loans ÷ (Tier 1 + Tier 2 capital).", whyValuable: "Shows how many times CRE exposure could be covered by regulatory capital." },
  "CRE / Equity": { definition: "Commercial real estate loans divided by total equity.", howCalculated: "CRE loans ÷ total equity.", whyValuable: "Measures CRE exposure relative to book equity cushion." },
  "Const / (T1+T2)": { definition: "Construction and land development loans divided by Tier 1 + Tier 2 capital.", howCalculated: "Construction loans ÷ (Tier 1 + Tier 2 capital).", whyValuable: "Construction loans are typically riskier; high ratio signals concentration in development." },
  "MF / (T1+T2)": { definition: "Multifamily real estate loans divided by Tier 1 + Tier 2 capital.", howCalculated: "Multifamily loans ÷ (Tier 1 + Tier 2 capital).", whyValuable: "Multifamily exposure relative to capital; often more stable than construction." },
  "ROA (Latest)": { definition: "Return on assets for the latest quarter.", howCalculated: "Net income ÷ total assets × 100 (FDIC ROA).", whyValuable: "Profitability per dollar of assets." },
  "ROA Δ (4Q)": { definition: "Change in ROA versus 4 quarters ago (percentage points).", howCalculated: "ROA (latest) − ROA (4 quarters ago).", whyValuable: "Trend in profitability; declining ROA suggests earnings pressure." },
  "Net Income (TTM)": { definition: "Trailing twelve months net income (sum of last 4 quarters).", howCalculated: "Sum of net income for the last four quarters.", whyValuable: "Annual earnings level; used for earnings buffer and YoY comparison." },
  "Net Income YoY %": { definition: "Year-over-year change in trailing twelve months net income (%).", howCalculated: "(NI TTM current − NI TTM prior year) ÷ |NI TTM prior year| × 100.", whyValuable: "Earnings trend; declining NI signals weakening profitability." },
  "NIM (Latest)": { definition: "Net interest margin for the latest quarter.", howCalculated: "Net interest income ÷ average earning assets × 100 (FDIC NIMR).", whyValuable: "Core spread on lending; compressed NIM limits earnings capacity." },
  "NIM Δ (4Q)": { definition: "Change in NIM versus 4 quarters ago (percentage points).", howCalculated: "NIM (latest) − NIM (4 quarters ago).", whyValuable: "Trend in interest margin; declining NIM suggests margin pressure." },
  "Earnings Buffer %": { definition: "Net income (TTM) divided by CRE loans.", howCalculated: "Net Income (TTM) ÷ CRE loans × 100.", whyValuable: "How much annual profit covers CRE book; thin buffer means less cushion if CRE losses materialize." },
  "CRE Mix": { definition: "Construction, multifamily, and non-residential loans shown as a share of total CRE.", howCalculated: "Each segment ÷ total CRE loans × 100.", whyValuable: "Reveals portfolio composition; construction-heavy mix is typically riskier." },
  "CRE Concentration (4Q)": { definition: "Quarter-by-quarter CRE concentration for the last 4 quarters.", howCalculated: "CRE loans ÷ total loans × 100 for each of the last 4 quarters.", whyValuable: "Shows trend in CRE exposure over time." },
  "NPL Ratio (4Q)": { definition: "Quarter-by-quarter NPL ratio for the last 4 quarters.", howCalculated: "Nonaccrual loans ÷ total loans × 100 for each quarter.", whyValuable: "Tracks credit quality trend; rising NPL over 4 quarters indicates deterioration." },
  "Total CRE Loans": { definition: "Total commercial real estate loans (dollars).", howCalculated: "Sum of CRE loans across institutions.", whyValuable: "Absolute exposure level for the cohort." },
  "Total UC": { definition: "Unused loan commitments (Schedule RC-L).", howCalculated: "FDIC UCLN field.", whyValuable: "Off-balance-sheet credit exposure; potential future loan draws." },
  "CRE UC": { definition: "Unused commitments for commercial real estate, construction, and land development.", howCalculated: "FDIC UCCOMRE field.", whyValuable: "CRE-specific off-balance-sheet exposure." },
  "Avg NPL Ratio": "Average of nonaccrual loans & leases divided by total loans & leases.",
  "Avg Noncurrent / Loans": "Average noncurrent loans (past due 90+ plus nonaccrual) as a share of gross loans (FDIC NCLNLSR).",
  "Avg Reserve Coverage": "Average loan loss reserve ratio (allowance relative to loans).",
  "Avg CRE Concentration": "Average CRE loans divided by total loans.",
  "Institutions Screened": "Count of unique banks with a latest-quarter record in the selected region.",
}

function isRichDef(def: MetricDef): def is MetricDefRich {
  return typeof def === "object" && def !== null && "definition" in def
}

export function DefTerm({
  term,
  children,
  customTrigger,
}: { term: string; children: React.ReactNode; customTrigger?: boolean }) {
  const def = METRIC_DEFINITIONS[term]
  if (!def) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {customTrigger ? (
          <>{children}</>
        ) : (
          <span className="cursor-help border-b border-dashed border-muted-foreground/50">{children}</span>
        )}
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className={isRichDef(def) ? "w-96 max-w-[90vw] text-left font-normal break-words" : "max-w-sm text-left font-normal"}
        sideOffset={6}
      >
        {isRichDef(def) ? (
          <div className="space-y-2 text-sm">
            <p><strong>Definition:</strong> {def.definition}</p>
            {def.howCalculated && <p><strong>How calculated:</strong> {def.howCalculated}</p>}
            {def.whyValuable && <p><strong>Why it matters:</strong> {def.whyValuable}</p>}
          </div>
        ) : (
          def
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * FDIC API integration for the AMO Dashboard.
 * Proxies FDIC financials server-side to avoid CORS and keep transformation logic centralized.
 */

const FDIC_BASE_URL = 'https://banks.data.fdic.gov'
const FDIC_FALLBACK_URL = 'https://api.fdic.gov/banks'
const FDIC_FINANCIALS_ENDPOINT = '/api/financials'
const FDIC_PAGE_SIZE = 10000

const FDIC_FIELDS = [
  'CERT', 'NAME', 'REPDTE', 'ASSET', 'DEP', 'LNRE', 'LNRECONS', 'LNREMULT',
  'LNRENRES', 'LNREOTH', 'LNREDOM', 'UCLN', 'UCCOMRE', 'LNLSNET', 'P3ASSET',
  'P9ASSET', 'NALNLS', 'NCLNLSR', 'NCLNLS', 'ROA', 'ROE', 'EEFFR', 'NIMR',
  'LNLSDEPR', 'NETINC', 'RBCT1CER', 'RBC1AAJ', 'RBC1RWAJ', 'RBCRWAJ', 'EQCAP',
  'STNAME', 'CITY',
]

export interface BankFinancialData {
  id: string
  name: string
  city?: string
  state?: string
  totalAssets: number
  creLoans: number
  creConcentration: number
  constructionLoans: number
  multifamilyLoans: number
  nonResidentialLoans: number
  otherRealEstateLoans: number
  residentialLoans: number
  totalUnusedCommitments: number
  creUnusedCommitments: number
  totalLoans: number
  nonaccrualLoans: number
  nplRatio: number
  pastDue3090: number
  pastDue90Plus: number
  noncurrent_to_loans_ratio: number
  noncurrent_to_assets_ratio: number
  roa: number
  roe: number
  efficiencyRatio: number
  loanLossReserve: number
  netInterestMargin: number
  cet1Ratio: number
  leverageRatio: number
  tier1RbcRatio: number
  totalRbcRatio: number
  netIncome: number
  reportDate?: string
  totalEquityDollars?: number | null
}

function toDollars(thousands: number | null | undefined): number {
  if (thousands === null || thousands === undefined || isNaN(thousands)) return 0
  return thousands * 1000
}

function normalizePercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !isFinite(value)) return 0
  if (value > 100) return value / 100
  if (value > 0 && value <= 1) return value * 100
  return value
}

function normalizePercentToDecimal(value: number | null | undefined): number {
  if (value === null || value === undefined || !isFinite(value)) return 0
  return value / 100
}

function transformFinancialData(rawData: any[]): BankFinancialData[] {
  if (!Array.isArray(rawData)) return []
  return rawData.map(bank => {
    const assets = toDollars(bank.ASSET)
    const constructionLoans = toDollars(bank.LNRECONS || 0)
    const multifamilyLoans = toDollars(bank.LNREMULT || 0)
    const nonResidentialLoans = toDollars(bank.LNRENRES || 0)
    const otherRealEstateLoans = toDollars(bank.LNREOTH || 0)
    const creLoans = constructionLoans + multifamilyLoans + nonResidentialLoans + otherRealEstateLoans
    const totalLoans = toDollars(bank.LNLSNET || 0)
    const nonaccrualLoans = toDollars(bank.NALNLS || 0)
    const totalLoansThousands = Number(bank.LNLSNET || 0)
    const nonAccrualLoansThousands = Number(bank.NALNLS || 0)
    const creConcentration = totalLoans > 0 ? (creLoans / totalLoans) * 100 : 0
    const nplRatio = totalLoansThousands > 0 ? nonAccrualLoansThousands / totalLoansThousands : 0
    const roa = normalizePercent(Number(bank.ROA || 0))
    const netInterestMargin = normalizePercent(Number(bank.NIMR || 0))

    const pastDue3090 = (() => {
      const p3 = Number(bank.P3ASSET || 0)
      const asset = Number(bank.ASSET || 0)
      if (asset <= 0 || !isFinite(p3)) return 0
      return Math.min(1, Math.max(0, p3 / asset))
    })()

    const pastDue90Plus = (() => {
      const p9 = Number(bank.P9ASSET || 0)
      const asset = Number(bank.ASSET || 0)
      if (asset <= 0 || !isFinite(p9)) return 0
      return Math.min(1, Math.max(0, p9 / asset))
    })()

    const noncurrent_to_loans_ratio = (() => {
      const raw = Number(bank.NCLNLSR || 0)
      return Math.min(1, Math.max(0, normalizePercentToDecimal(raw)))
    })()

    const noncurrent_to_assets_ratio = (() => {
      const raw = Number(bank.NCLNLS || 0)
      if (isFinite(raw) && raw !== 0) {
        return Math.min(1, Math.max(0, normalizePercentToDecimal(raw)))
      }
      const assetsT = Number(bank.ASSET || 0)
      const loansT = Number(bank.LNLSNET || 0)
      if (assetsT > 0 && loansT > 0) {
        const ntl = normalizePercentToDecimal(Number(bank.NCLNLSR || 0))
        return Math.min(1, Math.max(0, ntl * (loansT / assetsT)))
      }
      return 0
    })()

    return {
      id: String(bank.CERT || ''),
      name: bank.NAME || 'Unknown',
      city: bank.CITY,
      state: bank.STNAME,
      totalAssets: assets,
      creLoans,
      creConcentration: Number(creConcentration.toFixed(2)),
      constructionLoans,
      multifamilyLoans,
      nonResidentialLoans,
      otherRealEstateLoans,
      residentialLoans: toDollars(bank.LNREDOM || 0),
      totalUnusedCommitments: toDollars(bank.UCLN || 0),
      creUnusedCommitments: toDollars(bank.UCCOMRE || 0),
      totalLoans,
      nonaccrualLoans,
      nplRatio: Number(nplRatio.toFixed(4)),
      pastDue3090,
      pastDue90Plus,
      noncurrent_to_loans_ratio,
      noncurrent_to_assets_ratio,
      roa,
      roe: normalizePercent(Number(bank.ROE || 0)),
      efficiencyRatio: Number(bank.EEFFR || 0),
      loanLossReserve: normalizePercentToDecimal(Number(bank.LNLSDEPR || 0)),
      netInterestMargin,
      cet1Ratio: normalizePercent(Number(bank.RBCT1CER || 0)),
      leverageRatio: normalizePercent(Number(bank.RBC1AAJ || 0)),
      tier1RbcRatio: normalizePercent(Number(bank.RBC1RWAJ || 0)),
      totalRbcRatio: normalizePercent(Number(bank.RBCRWAJ || 0)),
      netIncome: toDollars(bank.NETINC || 0),
      reportDate: bank.REPDTE,
      totalEquityDollars: bank.EQCAP != null ? toDollars(bank.EQCAP) : undefined,
    }
  })
}

function buildRecentQuartersFilter(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 18)
  const startDate = d.toISOString().slice(0, 7) + '-01'
  return `[${startDate} TO *]`
}

async function fetchFromFDIC(url: string): Promise<any[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`FDIC API ${res.status}`)
    const json = await res.json()
    if (json.data && Array.isArray(json.data)) {
      return json.data.map((item: any) => item?.data ?? item)
    }
    if (Array.isArray(json)) {
      return json.map((item: any) => item?.data ?? item)
    }
    return []
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

export async function fetchFDICFinancials(
  state?: string,
  limit = 5000
): Promise<{ data: BankFinancialData[]; error?: string }> {
  try {
    const filters: string[] = [`REPDTE:${buildRecentQuartersFilter()}`]
    if (state) filters.push(`STNAME:"${state.toUpperCase()}"`)

    const params = new URLSearchParams({
      format: 'json',
      limit: String(Math.min(limit, FDIC_PAGE_SIZE)),
      filters: filters.join(' AND '),
      fields: FDIC_FIELDS.join(','),
      sort_by: 'ASSET',
      sort_order: 'DESC',
    })

    const urls = [
      `${FDIC_BASE_URL}${FDIC_FINANCIALS_ENDPOINT}?${params}`,
      `${FDIC_FALLBACK_URL}${FDIC_FINANCIALS_ENDPOINT}?${params}`,
    ]

    let lastErr = ''
    for (const url of urls) {
      try {
        const raw = await fetchFromFDIC(url)
        return { data: transformFinancialData(raw) }
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err)
      }
    }
    return { data: [], error: lastErr || 'Unable to reach FDIC API' }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : String(err) }
  }
}

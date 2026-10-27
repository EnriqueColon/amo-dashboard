import { useEffect, useMemo, useState } from 'react'
import { Gauge, Search } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { BankStressDrawer } from '@/components/BankStressDrawer'
import {
  loadBsMeta, loadBsRanking, formatQuarter, formatThousands, formatPct, formatScore, stressTone,
  BsError, TIER_LABEL, TIER_TONE, type BsMeta, type BsRankingRow,
} from '@/lib/bank-stress'

type Region = 'southeast' | 'florida' | 'national' | 'custom'
type SortKey = 'rank' | 'composite' | 'condition' | 'deterioration' | 'cre_exposure' | 'flag_count' | 'cre_concentration' | 'assets_k' | 'name' | 'noncurrent_ratio' | 'tier1_leverage'

const SORT_VALUE: Record<SortKey, (r: BsRankingRow) => number | string> = {
  rank: (r) => r.rank ?? 1e9,
  composite: (r) => r.composite ?? -1,
  condition: (r) => r.condition ?? -1,
  deterioration: (r) => r.deterioration ?? -1,
  cre_exposure: (r) => r.cre_exposure ?? -1,
  flag_count: (r) => r.flag_count,
  cre_concentration: (r) => r.cre_concentration ?? -1,
  assets_k: (r) => r.assets_k ?? -1,
  name: (r) => r.name,
  noncurrent_ratio: (r) => r.noncurrent_ratio ?? -1,
  tier1_leverage: (r) => r.tier1_leverage ?? 1e9,
}

const PAGE = 150

export default function BankStress() {
  const [meta, setMeta] = useState<BsMeta | null>(null)
  const [metaError, setMetaError] = useState<{ status: number; message: string } | null>(null)
  const [quarter, setQuarter] = useState<string>('')
  const [band, setBand] = useState<string>('')
  const [region, setRegion] = useState<Region>('southeast')
  const [customStates, setCustomStates] = useState<string>('')
  const [tier, setTier] = useState<string>('')
  const [minScore, setMinScore] = useState<string>('')
  const [creOnly, setCreOnly] = useState(false)
  const [sellerOnly, setSellerOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<BsRankingRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [sortDesc, setSortDesc] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const [selected, setSelected] = useState<BsRankingRow | null>(null)

  useEffect(() => {
    let mounted = true
    loadBsMeta()
      .then((m) => { if (!mounted) return; setMeta(m); setQuarter(m.latest_quarter) })
      .catch((err) => { if (mounted) setMetaError({ status: err instanceof BsError ? err.status : 0, message: err instanceof Error ? err.message : String(err) }) })
    return () => { mounted = false }
  }, [])

  const states = useMemo(() => {
    if (!meta) return []
    if (region === 'national') return []
    if (region === 'florida') return ['FL']
    if (region === 'southeast') return meta.definitions.deal_view.default_states
    return customStates.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s))
  }, [meta, region, customStates])

  useEffect(() => {
    if (!meta || !quarter) return
    let mounted = true
    setLoading(true)
    setError(null)
    setShown(PAGE)
    const minScoreNum = minScore.trim() === '' ? undefined : Number(minScore)
    loadBsRanking({ quarter, band: band || undefined, states, tier: tier || undefined, min_score: minScoreNum, cre_only: creOnly, seller_only: sellerOnly })
      .then((res) => { if (mounted) setRows(res.rows) })
      .catch((err) => { if (mounted) { setRows(null); setError(err instanceof Error ? err.message : String(err)) } })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [meta, quarter, band, states, tier, minScore, creOnly, sellerOnly])

  const filtered = useMemo(() => {
    if (!rows) return []
    const q = search.trim().toUpperCase()
    const base = q ? rows.filter((r) => r.name.toUpperCase().includes(q) || String(r.cert) === q) : rows
    const val = SORT_VALUE[sortKey]
    const sorted = [...base].sort((a, b) => {
      const av = val(a), bv = val(b)
      if (av < bv) return sortDesc ? 1 : -1
      if (av > bv) return sortDesc ? -1 : 1
      return (a.rank ?? 1e9) - (b.rank ?? 1e9)
    })
    return sorted
  }, [rows, search, sortKey, sortDesc])

  const summary = useMemo(() => {
    const t = { total: filtered.length, watchlist: 0, pressure: 0, sellers: 0 }
    for (const r of filtered) {
      if (r.tier === 'watchlist') t.watchlist++
      if (r.tier === 'pressure') t.pressure++
      if (r.cre_seller_signal) t.sellers++
    }
    return t
  }, [filtered])

  function sortBy(key: SortKey) {
    if (sortKey === key) setSortDesc((d) => !d)
    else { setSortKey(key); setSortDesc(key !== 'rank' && key !== 'name' && key !== 'tier1_leverage') }
  }

  const defs = meta?.definitions
  const flagLabel = (id: string) => defs?.flags.find((f) => f.id === id)?.label ?? defs?.watch_flags.find((f) => f.id === id)?.label ?? id
  const bandLabel = (key: string | null) => defs?.peer_bands.find((b) => b.key === key)?.label ?? key ?? '—'

  const Th = ({ k, children, title, align = 'right' }: { k: SortKey; children: React.ReactNode; title?: string; align?: 'left' | 'right' }) => (
    <th
      className={`py-2 px-2 font-medium text-slate-600 cursor-pointer select-none whitespace-nowrap ${align === 'left' ? 'text-left' : 'text-right'} ${sortKey === k ? 'text-slate-900' : ''}`}
      title={title}
      onClick={() => sortBy(k)}
    >
      {children}{sortKey === k ? (sortDesc ? ' ↓' : ' ↑') : ''}
    </th>
  )

  return (
    <div className="p-6 max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2"><Gauge className="h-6 w-6 text-slate-500" /> Bank Stress Ranking</h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Banks under earnings, credit and commercial-real-estate pressure, ranked within their asset-size peer group.
            The early signal for who will be selling distressed CRE loans. Source: FDIC Call Reports via the BankFind API, pulled directly.
          </p>
          {meta && (
            <p className="text-xs text-slate-500 mt-1">
              Data as of <span className="font-medium text-slate-700">{formatQuarter(meta.latest_quarter)}</span> ·
              computed {new Date(meta.computed_at).toLocaleString()} · {meta.banks_scored.toLocaleString()} banks ranked ·
              scores are percentile ranks within the peer band, higher = more stress
            </p>
          )}
        </div>
      </div>

      {metaError && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">{metaError.status === 503 ? 'Bank stress ranking has not been computed yet' : 'Bank stress ranking unavailable'}</p>
          <p className="mt-1">{metaError.message}</p>
          <p className="mt-1 text-xs text-amber-800">No figures are shown until the weekly job has produced bank_stress.db.</p>
        </div>
      )}

      {meta && (
        <>
          <div className="flex flex-wrap items-end gap-3 mb-3 text-sm">
            <label className="flex flex-col gap-1 text-xs text-slate-600">Quarter
              <select className="border rounded px-2 py-1 text-sm" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
                {meta.quarters.map((q) => <option key={q} value={q}>{formatQuarter(q)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">Region
              <select className="border rounded px-2 py-1 text-sm" value={region} onChange={(e) => setRegion(e.target.value as Region)}>
                <option value="southeast">Florida + Southeast ({meta.definitions.deal_view.default_states.join(', ')})</option>
                <option value="florida">Florida</option>
                <option value="national">National</option>
                <option value="custom">Pick states…</option>
              </select>
            </label>
            {region === 'custom' && (
              <label className="flex flex-col gap-1 text-xs text-slate-600">States (codes, comma-separated)
                <input className="border rounded px-2 py-1 text-sm w-48" placeholder="FL, GA, TX" value={customStates} onChange={(e) => setCustomStates(e.target.value)} />
              </label>
            )}
            <label className="flex flex-col gap-1 text-xs text-slate-600">Peer band
              <select className="border rounded px-2 py-1 text-sm" value={band} onChange={(e) => setBand(e.target.value)}>
                <option value="">All bands</option>
                {meta.definitions.peer_bands.map((b) => <option key={b.key} value={b.key}>{b.label} ({meta.band_counts[b.key] ?? 0})</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">Tier
              <select className="border rounded px-2 py-1 text-sm" value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="">All tiers</option>
                <option value="pressure">Likely pressure (5+ flags)</option>
                <option value="watchlist">Watchlist (3–4 flags)</option>
                <option value="normal">Normal (0–2 flags)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">Min composite
              <input className="border rounded px-2 py-1 text-sm w-24" type="number" min={0} max={100} placeholder="0" value={minScore} onChange={(e) => setMinScore(e.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700 pb-1" title={`CRE ≥ ${meta.definitions.deal_view.cre_concentration_min_pct}% of Tier 1 capital OR CRE loans ≥ ${formatThousands(meta.definitions.deal_view.cre_loans_min_k)}`}>
              <input type="checkbox" checked={creOnly} onChange={(e) => setCreOnly(e.target.checked)} /> Deal-sourcing view (CRE-heavy banks only)
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700 pb-1" title="Flags 5 + 6 + 8 together: provisioning behind losses, CRE charge-offs rising, selling at a loss">
              <input type="checkbox" checked={sellerOnly} onChange={(e) => setSellerOnly(e.target.checked)} /> CRE seller signal only
            </label>
            <label className="flex items-center gap-1 border rounded px-2 py-1 text-sm ml-auto">
              <Search className="h-3.5 w-3.5 text-slate-400" />
              <input className="outline-none w-44 text-sm" placeholder="Bank name or cert" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Banks shown', value: summary.total, tone: 'text-slate-900' },
              { label: 'Watchlist (3–4 flags)', value: summary.watchlist, tone: 'text-amber-700' },
              { label: 'Likely pressure (5+ flags)', value: summary.pressure, tone: 'text-red-700' },
              { label: 'CRE seller signal', value: summary.sellers, tone: 'text-red-700' },
            ].map((t) => (
              <div key={t.label} className="rounded-md border border-slate-200 bg-white px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">{t.label}</p>
                <p className={`text-xl font-semibold tabular-nums ${t.tone}`}>{t.value.toLocaleString()}</p>
              </div>
            ))}
          </div>

          {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-3">{error}</div>}

          <div className="rounded-md border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <Th k="rank" align="left" title="Rank among all ranked banks this quarter (composite, ties by CRE concentration)">#</Th>
                  <Th k="name" align="left">Bank</Th>
                  <th className="py-2 px-2 text-left font-medium text-slate-600">Band</th>
                  <Th k="composite" title="Weighted mean of the three sub-scores (40 / 40 / 20)">Composite</Th>
                  <Th k="condition" title="Level: ROA, core ROA, efficiency, noncurrent, reserve coverage, Tier 1 leverage, loans/deposits">Condition</Th>
                  <Th k="deterioration" title="Change: YoY and 4-quarter trend of NII/assets, funding cost, provision, CRE charge-offs, noncurrent">Deterior.</Th>
                  <Th k="cre_exposure" title="CRE/Tier 1, CRE share of charge-offs, loan & OREO sale gains/losses">CRE</Th>
                  <Th k="flag_count" title="Rule flags 1–8, one point each">Flags</Th>
                  <th className="py-2 px-2 text-left font-medium text-slate-600">Top drivers</th>
                  <th className="py-2 px-2 text-left font-medium text-slate-600">Signal</th>
                  <Th k="cre_concentration" title="(construction + multifamily + non-owner-occupied nonfarm nonres) / Tier 1 capital">CRE / T1</Th>
                  <Th k="noncurrent_ratio" title="Noncurrent loans / gross loans">Noncurr.</Th>
                  <Th k="tier1_leverage" title="Tier 1 leverage ratio">T1 lev.</Th>
                  <Th k="assets_k">Assets</Th>
                </tr>
              </thead>
              <tbody>
                {loading && !rows && Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={14} className="px-2 py-1.5"><Skeleton className="h-4 w-full" /></td></tr>
                ))}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={14} className="px-3 py-6 text-center text-slate-500">No banks match these filters.</td></tr>
                )}
                {filtered.slice(0, shown).map((r) => (
                  <tr key={r.cert} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setSelected(r)}>
                    <td className="py-1.5 px-2 tabular-nums text-slate-500">{r.rank ?? '—'}</td>
                    <td className="py-1.5 px-2">
                      <div className="font-medium text-slate-900">{r.name}</div>
                      <div className="text-[10px] text-slate-500">cert {r.cert} · {r.state ?? '—'}{r.hc_owned ? ' · HC-owned' : ''}{r.merger_quarter ? ' · merger qtr' : ''}{r.excluded_reason ? ` · ${r.excluded_reason.replace('_', ' ')}` : ''}</div>
                    </td>
                    <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">{bandLabel(r.peer_band)}</td>
                    <td className={`py-1.5 px-2 text-right tabular-nums font-semibold rounded ${stressTone(r.composite)}`} title={`completeness ${formatPct(r.completeness, 0)}`}>{formatScore(r.composite)}</td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${stressTone(r.condition)}`}>{formatScore(r.condition)}</td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${stressTone(r.deterioration)}`}>{formatScore(r.deterioration)}</td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${stressTone(r.cre_exposure)}`}>{formatScore(r.cre_exposure)}</td>
                    <td className="py-1.5 px-2 text-right">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${TIER_TONE[r.tier]}`} title={[...r.flags, ...r.watch_flags].map(flagLabel).join('\n') || 'no flags'}>
                        {r.flag_count} · {TIER_LABEL[r.tier]}
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-slate-600 max-w-[260px]">
                      {r.top_drivers.slice(0, 3).map((d) => (
                        <span key={d.id} className="inline-block mr-1 mb-0.5 rounded bg-slate-100 px-1 py-0.5 text-[10px] whitespace-nowrap" title={`${d.label}: ${d.percentile.toFixed(0)}th percentile`}>{d.label} <span className="text-slate-400">{d.percentile.toFixed(0)}</span></span>
                      ))}
                    </td>
                    <td className="py-1.5 px-2">
                      {r.cre_seller_signal ? <span className="inline-block rounded bg-red-600 text-white px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap" title="Flags 5, 6 and 8 together">CRE seller</span> : null}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{formatPct(r.cre_concentration, 0)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{formatPct(r.noncurrent_ratio, 2)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{formatPct(r.tier1_leverage, 1)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{formatThousands(r.assets_k)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > shown && (
              <div className="p-2 text-center border-t border-slate-100">
                <button className="text-xs text-slate-700 underline" onClick={() => setShown((s) => s + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length.toLocaleString()}</button>
              </div>
            )}
          </div>

          <details className="mt-4 text-xs text-slate-600">
            <summary className="cursor-pointer font-medium text-slate-700">How the ranking is built</summary>
            <div className="mt-2 grid md:grid-cols-2 gap-4">
              <div>
                <p className="font-medium text-slate-800">Sub-scores and weights</p>
                <ul className="list-disc ml-4 mt-1 space-y-0.5">
                  {Object.entries(meta.definitions.components).map(([sub, comps]) => (
                    <li key={sub}><span className="capitalize font-medium">{sub.replace('_', ' ')}</span> ({Math.round((meta.definitions.weights[sub] ?? 0) * 100)}%): {comps.map((c) => c.label).join(', ')}</li>
                  ))}
                </ul>
                <p className="mt-2">Each component is its percentile within the peer band (higher = more stress). A sub-score is the mean of its available components; the composite re-weights the available sub-scores. Banks established in the last {meta.definitions.de_novo_years} years are shown but not ranked.</p>
              </div>
              <div>
                <p className="font-medium text-slate-800">Flags (one point each)</p>
                <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                  {meta.definitions.flags.map((f) => <li key={f.id}><span className="font-medium">{f.label}</span> — {f.rule}</li>)}
                </ol>
                <p className="mt-2">Tiers: 0–2 normal, {meta.definitions.tiers.watchlist_min_flags}–{meta.definitions.tiers.pressure_min_flags - 1} watchlist, {meta.definitions.tiers.pressure_min_flags}+ likely pressure. Flags {meta.definitions.cre_seller_signal_flags.map((f) => f.replace('f', '')).join(' + ')} together = CRE seller signal. Watch flags (not counted): {meta.definitions.watch_flags.map((w) => w.label).join('; ')}.</p>
              </div>
            </div>
          </details>
        </>
      )}

      <BankStressDrawer cert={selected?.cert ?? null} name={selected?.name} onClose={() => setSelected(null)} definitions={meta?.definitions ?? null} />
    </div>
  )
}

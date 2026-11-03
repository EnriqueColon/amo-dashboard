import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DefTerm } from '@/components/DefTerm'
import { Tooltip as HoverTip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { InstitutionDetailSections } from '@/components/InstitutionProfileDrawer'
import {
  loadBsBank, formatQuarter, formatThousands, formatPct, formatScore, stressTone, TIER_LABEL, TIER_TONE,
  type BsBankDetail, type BsDefinitions, type BsHistoryRow,
} from '@/lib/bank-stress'

type Series = { key: string; label: string; color: string; decimals?: number }
type Panel = { title: string; hint: string; series: Series[]; references?: Array<{ y: number; label: string }>; unit: 'pct' | 'score' | 'x' }

// Every series is a bank_metrics column (percent units) or a score (0–100).
const PANELS: Panel[] = [
  { title: 'Stress scores', hint: 'Percentile ranks within the peer band, 0–100. Higher = more stress.', unit: 'score',
    series: [{ key: 'composite', label: 'Composite', color: '#0f172a' }, { key: 'condition', label: 'Condition', color: '#2563eb' }, { key: 'deterioration', label: 'Deterioration', color: '#f59e0b' }, { key: 'cre_exposure', label: 'CRE exposure', color: '#dc2626' }] },
  { title: 'Earnings (% of avg assets, annualized)', hint: 'Core ROA strips loan-sale and OREO gains. Falling NII/assets is flag 2.', unit: 'pct',
    series: [{ key: 'roa', label: 'ROA', color: '#16a34a' }, { key: 'core_roa', label: 'Core ROA', color: '#0ea5e9' }, { key: 'nii_ratio', label: 'NII / assets', color: '#64748b' }] },
  { title: 'Credit (% of loans)', hint: 'Noncurrent loans, provision and CRE net charge-offs. Rising CRE charge-offs for two quarters is flag 6.', unit: 'pct',
    series: [{ key: 'noncurrent_ratio', label: 'Noncurrent', color: '#dc2626' }, { key: 'provision_ratio', label: 'Provision / assets', color: '#f59e0b' }, { key: 'cre_nco_ratio', label: 'CRE NCO / CRE loans', color: '#7c3aed' }] },
  { title: 'CRE concentration (% of Tier 1 capital)', hint: 'Interagency guidance: 300% CRE, 100% construction. Owner-occupied excluded.', unit: 'pct',
    series: [{ key: 'cre_concentration', label: 'CRE / Tier 1', color: '#dc2626', decimals: 0 }, { key: 'construction_concentration', label: 'Construction / Tier 1', color: '#f59e0b', decimals: 0 }],
    references: [{ y: 300, label: '300%' }, { y: 100, label: '100%' }] },
  { title: 'Funding & efficiency (%)', hint: 'Funding cost = interest expense / interest income (flag 3 if up 10 pts YoY). Efficiency > 70% is flag 4.', unit: 'pct',
    series: [{ key: 'funding_cost_ratio', label: 'Funding cost', color: '#f59e0b', decimals: 0 }, { key: 'efficiency_ratio', label: 'Efficiency', color: '#64748b', decimals: 0 }, { key: 'loan_to_deposit', label: 'Loans / deposits', color: '#0ea5e9', decimals: 0 }] },
  { title: 'Capital (%)', hint: 'Tier 1 leverage (watch < 8%, critical < 5%) and unrealized securities gains/losses as % of equity.', unit: 'pct',
    series: [{ key: 'tier1_leverage', label: 'Tier 1 leverage', color: '#16a34a' }, { key: 'unrealized_sec_to_equity', label: 'Unrealized sec. / equity', color: '#dc2626' }],
    references: [{ y: 8, label: '8%' }] },
]

const TICK = { fontSize: 10, fill: '#64748b' }

function PanelChart({ panel, points }: { panel: Panel; points: Array<Record<string, unknown>> }) {
  const series = panel.series.filter((s) => points.some((p) => p[s.key] != null))
  if (!series.length) return null
  const decimals = Math.max(...series.map((s) => s.decimals ?? 2))
  const fmt = (v: unknown) => (typeof v === 'number' ? (panel.unit === 'score' ? v.toFixed(1) : `${v.toFixed(decimals)}%`) : '—')
  return (
    <div className="rounded-md border border-slate-200/80 p-3">
      <p className="text-xs font-semibold text-slate-700"><DefTerm term={`bank-card:${panel.title.split(" (")[0]}`}>{panel.title}</DefTerm></p>
      <p className="text-[11px] text-slate-500 leading-snug mb-1">{panel.hint}</p>
      <ResponsiveContainer width="100%" height={170} debounce={0}>
        <LineChart data={points} margin={{ top: 10, right: panel.references ? 34 : 12, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => (panel.unit === 'score' ? String(v) : `${v}%`)} domain={panel.unit === 'score' ? [0, 100] : ['auto', 'auto']} />
          <Tooltip content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            return (
              <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm text-xs">
                <p className="font-medium text-slate-800 mb-1">{String(label)}</p>
                {payload.map((item) => (
                  <div key={String(item.dataKey)} className="flex items-center justify-between gap-4 py-0.5">
                    <span className="flex items-center gap-1.5 text-slate-600"><span className="inline-block h-2 w-2 rounded-full" style={{ background: item.color }} />{item.name}</span>
                    <span className="tabular-nums">{fmt(item.value)}</span>
                  </div>
                ))}
              </div>
            )
          }} />
          <Legend verticalAlign="top" align="right" iconType="plainline" iconSize={10} wrapperStyle={{ fontSize: '10px', color: '#475569', paddingBottom: '4px' }} />
          {panel.references?.map((r) => <ReferenceLine key={r.y} y={r.y} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: r.label, position: 'right', fontSize: 9, fill: '#94a3b8' }} />)}
          {series.map((s) => <Line key={s.key} type="monotone" name={s.label} dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: s.color }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Hover text for labels whose definition comes from the data (rule tests, metric formulas), not the glossary.
function Hint({ text, children }: { text?: string | null; children: ReactNode }) {
  if (!text) return <>{children}</>
  return (
    <HoverTip>
      <TooltipTrigger asChild><span className="cursor-help border-b border-dashed border-muted-foreground/50">{children}</span></TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm text-left font-normal" sideOffset={6}>{text}</TooltipContent>
    </HoverTip>
  )
}
const D = ({ k, children }: { k: string; children: ReactNode }) => <DefTerm term={`bank-card:${k}`}>{children}</DefTerm>

const SUB_TERM: Record<string, string> = { condition: 'bank-stress:Condition', deterioration: 'bank-stress:Deterior.', cre_exposure: 'bank-stress:CRE' }
const SECTION_IDS = ['drivers', 'charts', 'rules', 'components', 'quarterly', 'fdic'] as const
// Every section starts closed so the score tiles and flags stay in view; a click opens the one you want. Collapsed sections do not render,
// so the FDIC detail only loads when someone asks for it.
const DEFAULT_OPEN = new Set<string>()

function Section({ id, title, open, toggle, children }: { id: string; title: ReactNode; open: (id: string) => boolean; toggle: (id: string) => void; children: ReactNode }) {
  const isOpen = open(id)
  return (
    <section className="rounded-md border border-slate-200">
      <button type="button" onClick={() => toggle(id)} aria-expanded={isOpen}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50">
        {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />}
        <span>{title}</span>
      </button>
      {isOpen && <div className="border-t border-slate-100 px-3 py-3">{children}</div>}
    </section>
  )
}

export function BankStressDrawer({ cert, name, onClose, definitions }: { cert: number | null; name?: string; onClose: () => void; definitions: BsDefinitions | null }) {
  const [detail, setDetail] = useState<BsBankDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(DEFAULT_OPEN))
  const isOpen = (id: string) => openSections.has(id)
  const toggle = (id: string) => setOpenSections((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  useEffect(() => { setOpenSections(new Set(DEFAULT_OPEN)) }, [cert])

  useEffect(() => {
    if (cert == null) { setDetail(null); setError(null); return }
    let mounted = true
    setLoading(true)
    setDetail(null)
    setError(null)
    loadBsBank(cert)
      .then((d) => { if (mounted) setDetail(d) })
      .catch((err) => { if (mounted) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [cert])

  const latest = detail?.history[detail.history.length - 1]
  const points = (detail?.history ?? []).map((h) => ({ ...h, label: formatQuarter(h.repdte) }))
  const flagLabel = (id: string) => definitions?.flags.find((f) => f.id === id)?.label ?? definitions?.watch_flags.find((f) => f.id === id)?.label ?? id
  const bandLabel = (key: string | null) => definitions?.peer_bands.find((b) => b.key === key)?.label ?? key ?? '—'
  const metricDef = (key: string) => definitions?.metrics.find((m) => m.key === key)
  const driverDef = (id: string) => { for (const comps of Object.values(definitions?.components ?? {})) { const c = comps.find((x) => x.id === id); if (c) return metricDef(c.metric)?.formula } return undefined }

  return (
    <Dialog open={cert != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="w-[96vw] sm:max-w-4xl max-h-[90vh] overflow-y-auto overflow-x-hidden grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle className="text-lg">{detail?.bank.name ?? name ?? `Cert ${cert}`}</DialogTitle>
          <DialogDescription asChild>
            <div className="text-xs text-slate-500">
              {detail && (
                <>cert {detail.bank.cert} · {detail.bank.city ? `${detail.bank.city}, ` : ''}{detail.bank.state ?? '—'} · {formatThousands(detail.bank.assets_k)} assets · {bandLabel(latest?.peer_band ?? null)} band
                  {detail.bank.hc_owned ? <> · owned by <span className="text-slate-700">{detail.bank.hc_name ?? 'a holding company'}</span> (payout rule not applied)</> : ' · standalone bank'}
                  {detail.bank.estymd ? ` · est. ${String(detail.bank.estymd).slice(0, 4)}` : ''}{detail.bank.cblr ? ' · CBLR filer' : ''}
                  {detail.failure ? <span className="text-red-700 font-medium"> · FAILED {detail.failure.faildate}</span> : null}
                </>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {loading && <p className="text-sm text-slate-500 mt-4">Loading…</p>}
        {error && <p className="text-sm text-red-700 mt-4">{error}</p>}

        {detail && latest && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {[
                { label: 'Composite', term: 'bank-stress:Composite', value: latest.composite },
                { label: 'Condition', term: 'bank-stress:Condition', value: latest.condition },
                { label: 'Deterioration', term: 'bank-stress:Deterior.', value: latest.deterioration },
                { label: 'CRE exposure', term: 'bank-stress:CRE', value: latest.cre_exposure },
              ].map((t) => (
                <div key={t.label} className={`rounded-md border border-slate-200 px-3 py-2 ${stressTone(t.value)}`}>
                  <p className="text-[10px] uppercase tracking-wide opacity-70"><DefTerm term={t.term}>{t.label}</DefTerm></p>
                  <p className="text-xl font-semibold tabular-nums">{formatScore(t.value)}</p>
                </div>
              ))}
              <div className="rounded-md border border-slate-200 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-slate-500"><D k="Rank">Rank · {formatQuarter(latest.repdte)}</D></p>
                <p className="text-sm font-semibold tabular-nums text-slate-900">{latest.rank ?? '—'} <span className="text-slate-400 font-normal">of {latest.cohort_size.toLocaleString()}</span></p>
                <p className="text-[11px] text-slate-500 tabular-nums">{latest.rank_in_band ?? '—'} of {latest.band_size.toLocaleString()} in band · {formatPct(latest.completeness, 0)} complete</p>
                {latest.excluded_reason && <p className="text-[11px] text-amber-700">not ranked: {latest.excluded_reason.replace('_', ' ')}</p>}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded border px-2 py-0.5 text-xs ${TIER_TONE[latest.tier]}`}>{latest.flag_count} flags · {TIER_LABEL[latest.tier]}</span>
              {latest.cre_seller_signal ? <span className="rounded bg-red-600 text-white px-2 py-0.5 text-xs font-medium">CRE seller signal</span> : null}
              {latest.flags.map((f) => <span key={f} className="rounded border border-red-200 bg-red-50 text-red-800 px-2 py-0.5 text-[11px]" title={definitions?.flags.find((d) => d.id === f)?.rule}>{f.toUpperCase()} {flagLabel(f)}</span>)}
              {latest.watch_flags.map((f) => <span key={f} className="rounded border border-amber-200 bg-amber-50 text-amber-800 px-2 py-0.5 text-[11px]">{flagLabel(f)}</span>)}
              {latest.merger_quarter ? <span className="rounded border border-slate-200 bg-slate-50 text-slate-600 px-2 py-0.5 text-[11px]">merger quarter — trends suppressed</span> : null}
            </div>

            <div className="flex items-center justify-end gap-3 text-[11px]">
              <span className="text-slate-500 mr-auto">Pick what to look at:</span>
              <button type="button" className="text-primary hover:underline" onClick={() => setOpenSections(new Set(SECTION_IDS))}>Expand all</button>
              <button type="button" className="text-primary hover:underline" onClick={() => setOpenSections(new Set())}>Collapse all</button>
            </div>

            <Section id="drivers" title={<D k="Top drivers">Top drivers</D>} open={isOpen} toggle={toggle}>
              <div className="grid md:grid-cols-3 gap-2">
                {latest.top_drivers.map((d) => (
                  <div key={d.id} className="rounded-md border border-slate-200 px-3 py-2">
                    <p className="text-[11px] text-slate-600"><Hint text={driverDef(d.id)}>{d.label}</Hint></p>
                    <p className="text-sm font-semibold tabular-nums text-slate-900">{d.percentile.toFixed(0)}<span className="text-xs font-normal text-slate-500">th pct</span> <span className="text-xs font-normal text-slate-500">· {d.value == null ? '—' : d.value.toFixed(2)}</span></p>
                  </div>
                ))}
              </div>
            </Section>

            <Section id="charts" title={<D k="Trend charts">Trend charts</D>} open={isOpen} toggle={toggle}>
              {PANELS.map((p) => <PanelChart key={p.title} panel={p} points={points} />)}
            </Section>

            <Section id="rules" title={<D k="Rules">Which stress rules the bank tripped, quarter by quarter</D>} open={isOpen} toggle={toggle}>
              <p className="text-[11px] text-slate-500 mb-1">One row per rule, one column per quarter, oldest on the left. A red cell means the rule tripped that quarter; read across a row to see whether a problem is new or has persisted, read down a column to see how many rules fired at once. Hover a rule for its exact threshold.</p>
              <table className="text-[11px] w-full">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left font-medium py-1 pr-2"><D k="Rule">Rule</D></th>
                    {detail.history.map((h) => <th key={h.repdte} className="text-center font-medium py-1 whitespace-nowrap">{formatQuarter(h.repdte)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(definitions?.flags ?? []).map((f, i) => (
                    <tr key={f.id} className="border-t border-slate-100">
                      <td className="py-1 pr-2 text-slate-700 whitespace-nowrap"><span className="text-slate-400 mr-1">{i + 1}.</span><Hint text={f.rule}>{f.label}</Hint></td>
                      {detail.history.map((h) => {
                        const on = h.flags.includes(f.id)
                        return (
                          <td key={h.repdte} className="text-center py-1" title={`${formatQuarter(h.repdte)}: ${on ? 'tripped' : 'not tripped'} — ${f.rule}`}>
                            <span className={`inline-block h-4 w-6 rounded-sm ${on ? 'bg-red-500' : 'bg-slate-100'}`} aria-label={on ? 'tripped' : 'clear'} />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 font-medium">
                    <td className="py-1 pr-2 text-slate-700"><D k="Rules tripped">Rules tripped</D></td>
                    {detail.history.map((h) => <td key={h.repdte} className="text-center py-1 tabular-nums">{h.flag_count}</td>)}
                  </tr>
                  <tr>
                    <td className="py-1 pr-2 text-slate-700"><D k="Tier">Tier</D></td>
                    {detail.history.map((h) => <td key={h.repdte} className="text-center py-1"><span className={`rounded border px-1 py-0.5 text-[10px] ${TIER_TONE[h.tier]}`}>{TIER_LABEL[h.tier]}</span></td>)}
                  </tr>
                  <tr>
                    <td className="py-1 pr-2 text-slate-700"><D k="Composite row">Composite</D></td>
                    {detail.history.map((h) => <td key={h.repdte} className={`text-center py-1 tabular-nums font-medium ${stressTone(h.composite)}`}>{formatScore(h.composite)}</td>)}
                  </tr>
                  <tr>
                    <td className="py-1 pr-2 text-slate-700"><D k="CRE seller signal">CRE seller signal</D></td>
                    {detail.history.map((h) => <td key={h.repdte} className="text-center py-1">{h.cre_seller_signal ? <span className="rounded bg-red-600 text-white px-1 py-0.5 text-[10px]">yes</span> : <span className="text-slate-300">—</span>}</td>)}
                  </tr>
                </tbody>
              </table>
            </Section>

            <Section id="components" title={<D k="Component percentiles">Component percentiles · {formatQuarter(latest.repdte)}</D>} open={isOpen} toggle={toggle}>
              <div className="grid md:grid-cols-3 gap-3 text-[11px]">
                {Object.entries(definitions?.components ?? {}).map(([sub, comps]) => (
                  <div key={sub}>
                    <p className="font-medium text-slate-700 capitalize mb-1"><DefTerm term={SUB_TERM[sub] ?? ''}>{sub.replace('_', ' ')}</DefTerm> <span className="text-slate-400 font-normal">({Math.round((definitions?.weights[sub] ?? 0) * 100)}%)</span></p>
                    {comps.map((c) => {
                      const p = latest.components?.[c.id]
                      const v = num((latest as BsHistoryRow)[c.id])
                      return (
                        <div key={c.id} className="flex items-center gap-2 py-0.5">
                          <span className="w-40 truncate text-slate-600"><Hint text={metricDef(c.metric)?.formula}>{c.label}</Hint></span>
                          <span className="flex-1 h-1.5 rounded bg-slate-100"><span className="block h-1.5 rounded bg-red-400" style={{ width: `${p ?? 0}%` }} /></span>
                          <span className="w-8 text-right tabular-nums">{p == null ? '—' : p.toFixed(0)}</span>
                          <span className="w-14 text-right tabular-nums text-slate-500">{v == null ? '—' : v.toFixed(2)}</span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </Section>

            <Section id="quarterly" title={<D k="Quarterly figures">Quarterly figures ($ thousands)</D>} open={isOpen} toggle={toggle}>
              <table className="text-[11px] w-full">
                <thead><tr className="text-slate-500"><th className="text-left font-medium py-1"><Hint text="Calendar quarter the Call Report covers, oldest at the bottom.">Quarter</Hint></th><th className="text-right font-medium"><D k="Net income">Net income</D></th><th className="text-right font-medium"><D k="Provision">Provision</D></th><th className="text-right font-medium"><D k="Net charge-offs">Net charge-offs</D></th><th className="text-right font-medium"><D k="CRE NCO">CRE NCO</D></th><th className="text-right font-medium"><D k="Loan-sale G/L">Loan-sale G/L</D></th><th className="text-right font-medium"><D k="OREO G/L">OREO G/L</D></th><th className="text-right font-medium"><D k="Dividends">Dividends</D></th><th className="text-right font-medium"><D k="Prov. coverage">Prov. coverage</D></th><th className="text-right font-medium"><D k="Held for sale">Held for sale</D></th></tr></thead>
                <tbody>
                  {[...detail.history].reverse().map((h) => {
                    const creNco = [h.q_NTRECONS, h.q_NTREMULT, h.q_NTRENROT].map(num)
                    const creSum = creNco.every((x) => x != null) ? (creNco as number[]).reduce((a, b) => a + b, 0) : null
                    return (
                      <tr key={h.repdte} className="border-t border-slate-100 tabular-nums">
                        <td className="py-1 text-slate-700">{formatQuarter(h.repdte)}</td>
                        <td className="text-right">{formatThousands(num(h.q_NETINC))}</td>
                        <td className="text-right">{formatThousands(num(h.q_ELNATR))}</td>
                        <td className="text-right">{formatThousands(num(h.q_NTLNLS))}</td>
                        <td className="text-right">{formatThousands(creSum)}</td>
                        <td className={`text-right ${(num(h.q_NETGNSLN) ?? 0) < 0 ? 'text-red-700' : ''}`}>{formatThousands(num(h.q_NETGNSLN))}</td>
                        <td className={`text-right ${(num(h.q_NETGNSRE) ?? 0) < 0 ? 'text-red-700' : ''}`}>{formatThousands(num(h.q_NETGNSRE))}</td>
                        <td className="text-right">{formatThousands(num(h.q_EQCDIV))}</td>
                        <td className="text-right">{num(h.provision_coverage) == null ? '—' : `${(num(h.provision_coverage) as number).toFixed(2)}×`}</td>
                        <td className="text-right whitespace-nowrap">
                          {formatThousands(num(h.hfs_k))}
                          {num(h.hfs_pct) != null && <span className="text-slate-500"> · {(num(h.hfs_pct) as number).toFixed(2)}% of loans</span>}
                          {(num(h.hfs_troubled_k) ?? 0) > 0 && <span className="text-red-700"> · {formatThousands(num(h.hfs_troubled_k))} troubled</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Section>

            {/* From the former FDIC Data Analytics drawer: capital/earnings verdict, quarter table, acquisitions, balance-sheet actions. */}
            <Section id="fdic" title={<D k="FDIC detail">FDIC detail — capital, acquisitions and balance-sheet actions</D>} open={isOpen} toggle={toggle}>
              <div className="space-y-3">
                <InstitutionDetailSections cert={String(detail.bank.cert)} hideTrendCharts />
              </div>
            </Section>

            {detail.aom_canonical_names.length > 0 && (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                <p className="font-medium text-slate-700">In the county filings as</p>
                <p>{detail.aom_canonical_names.join(' · ')}</p>
                <p className="mt-1 text-slate-500">Look this name up on the Reporting tab to see its recorded loan sales — the validation path for this score.</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

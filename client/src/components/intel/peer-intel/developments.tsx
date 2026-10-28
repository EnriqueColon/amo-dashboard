"use client"

import { Card } from "@/components/ui/card"
import type { PeerIntelPayload } from "@/lib/intel/peer-intel-types"
import { DEVELOPMENT_MAX_AGE_DAYS } from "@shared/peer-intel/developments"
import { layerName } from "@shared/peer-intel/panel"
import type { PeerLayer } from "@shared/peer-intel/edgar-contract"

/**
 * Other developments — the last of the brief's five asks.
 *
 * Everything else on this tab comes from a filing, which makes it accurate and
 * late: a fund close is reported weeks before the Form D amendment confirms it.
 * This is the opposite, so it is framed as a prompt to look rather than a figure
 * to quote, and every item links to the publisher rather than being summarised
 * here — a headline restated is a headline that can be restated wrongly.
 *
 * The filter is strict by design. A manager is only recognised by an exact
 * phrase of two words or more, because the registry contains firms called
 * Bridge, Ladder, Camden, Apollo and Ares, and matching those on a short name
 * would attribute other people's news to a competitor. A missing item is a gap;
 * a misattributed one is a wrong answer.
 */

export function Developments({
  layer,
  developments,
  onSelectManager,
}: {
  layer: PeerLayer
  developments: PeerIntelPayload["developments"]
  onSelectManager?: (peerId: string) => void
}) {
  const { items, considered, failures, unsearchable } = developments

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-800">Other developments — {layerName(layer)}</h3>
        <p className="mt-1 max-w-3xl text-xs text-slate-600">
          Press coverage of tracked managers from the last {DEVELOPMENT_MAX_AGE_DAYS} days: fund closes and launches,
          redemption and liquidity news, leadership changes, disputes. Unlike everything else on this tab, this is not
          from a filing — treat it as a prompt to look, not a figure to quote.
        </p>
      </div>

      {failures.length > 0 && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          The news feed could not be read for {failures.length === 1 ? "one manager" : `${failures.length} managers`}
          {failures.length <= 3 && <> ({failures.map((f) => f.manager).join(", ")})</>}, so this list may be
          incomplete. Every other panel on this tab is unaffected — they read SEC filings directly.
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-slate-600">
          Nothing in the last {DEVELOPMENT_MAX_AGE_DAYS} days passed the filter
          {considered > 0 && <> out of {considered} items considered</>}. That is a normal result: the filter requires a
          manager&apos;s full name in the headline and a fund-level event, and rejects single-asset coverage and
          sell-side price-target notes.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((d) => (
            <li key={`${d.peerId}-${d.url}`} className="py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <button
                  type="button"
                  onClick={onSelectManager ? () => onSelectManager(d.peerId) : undefined}
                  className={`text-[11px] font-semibold uppercase tracking-wide text-primary ${
                    onSelectManager ? "hover:underline" : "cursor-default"
                  }`}
                >
                  {d.manager}
                </button>
                <span className="text-[11px] text-slate-400">{d.publishedAt}</span>
                {d.source && <span className="text-[11px] text-slate-400">· {d.source}</span>}
              </div>
              <a
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 block text-sm leading-snug text-slate-800 hover:text-primary hover:underline"
              >
                {d.title}
              </a>
              <div
                className="mt-0.5 text-[11px] text-slate-500"
                title={`Attributed to ${d.manager} because the headline contains the exact phrase "${d.matchedPhrase}". Kept because it mentions: ${d.matchedTerms.join(", ")}.`}
              >
                matched &ldquo;{d.matchedPhrase}&rdquo; · {d.matchedTerms.slice(0, 3).join(", ")}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        {considered > 0 && (
          <>
            {considered} items considered, {items.length} kept.{" "}
          </>
        )}
        Each item says which exact phrase attributed it to a manager, so a wrong attribution is visible rather than
        hidden. Headlines are the publisher&apos;s words and link out; nothing is summarised or rewritten here.
        {unsearchable.length > 0 && (
          <>
            {" "}
            Not searched, because no name long enough to be unambiguous: {unsearchable.join(", ")}.
          </>
        )}
      </p>
    </Card>
  )
}

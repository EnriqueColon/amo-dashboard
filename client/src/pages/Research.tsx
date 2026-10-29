import { MarketResearch } from "@/components/intel/research/market-research"

/**
 * Market Research — the latest publications from the major CRE research
 * houses, found each morning, plus the firm's own library of uploaded
 * reports with summaries. Rebuilt here from the Market Intelligence tool.
 */
export default function Research() {
  return (
    <div className="p-6">
      <MarketResearch />
    </div>
  )
}

import { NewsMorningPage } from "@/components/intel/news/morning-page"

/**
 * News — the Market Intelligence tool's morning page, rebuilt here: a scan
 * for the start of the day. The Real Deal picks (where the publisher lets the
 * server read them), industry and finance news newest first, the industry
 * outlook condensed to its key signals, and a digest for any link.
 */
export default function News() {
  return (
    <div className="p-6">
      <NewsMorningPage />
    </div>
  )
}

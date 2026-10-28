/**
 * The committed Form ADV extract, loaded once.
 *
 * `adv-extract.json` is written by `npm run refresh:peer-adv` and committed;
 * it is a build-time input like the registry, not something fetched. Kept
 * behind a function so a test can pass its own extract and so the JSON's
 * shape is checked at one place rather than trusted wherever it is read.
 */

import extract from "./adv-extract.json"
import history from "./adv-history.json"
import type { AdvExtract } from "./adv-link"
import type { AdvHistory } from "./adv-history"

export function advExtract(): AdvExtract {
  return extract as AdvExtract
}

/**
 * The committed history, 2011–2024, from the SEC's bulk filing data; written
 * by `npm run build:adv-history`. The current extract supplies the newest
 * point on top of it.
 */
export function advHistory(): AdvHistory {
  return history as AdvHistory
}

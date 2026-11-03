# Session.md — UI brainstorm log

Purpose: notes from the UI-change brainstorming sessions for the SHCP Intelligence Platform (formerly AMO Dashboard). **Discussion only — no code changes are made in these sessions.** Decisions recorded here feed later build sessions. This file is separate from `SESSION_LOG.md` (the dense engineering handoff log).

---

## Session 1 — 2026-10-28

### Ground rules
- Review current state, data and functionality; discuss requested UI changes.
- No coding, no deploys, no file changes other than this log.

### Current UI state (as of this session)

**Shell**
- Left sidebar, collapsible to icon rail (`client/src/components/Sidebar.tsx`). Brand "SHCP Intelligence / Platform · Safe Harbor Capital Partners". Amber/gold brand mark.
- Global **County** selector in the sidebar (Miami-Dade, Broward, Hillsborough, All) — applies to every page.
- Hash routing (`#/ask`, `#/overview` …). Landing page is **Ask the Data** (owner request, 7 Oct 2026).
- Single shared password login; Sign out in sidebar footer.
- Every data table: CFN lookup box; column headers have hover glossary (Definition / How calculated / Why it matters) — added 28 Oct 2026.

**Navigation (sidebar groups → pages)**

| Group | Page | Route | Notes |
|---|---|---|---|
| (top) | Ask the Data | `/ask` | Beta badge. LLM chat over the DB with lookups strip, drill-down rows, charts. |
| (top) | Overview | `/overview` | Headline counts, monthly volume chart, Top Acquirers / Sellers / Most Connected, completeness card. |
| Analysis | Reporting | `/reporting` | Main working surface: filterable transaction table, doc-type pills, category pills, participant panels, chart, Excel download, entity report, paste-a-list. 755 lines, densest page. |
| Analysis | Targets | `/targets` | Watchlist of entities → links into Reporting. |
| Analysis | FDIC Data Analytics | `/market-analytics` | Bank screening from own FDIC pull; scope selector, NPL cards, cohort summary, screening list, institution drawer. |
| Analysis | Bank Stress Ranking | `/bank-stress` | New badge. Composite + 3 sub-scores, flags, tiers, CRE-seller badge, drawer. |
| Analysis | Clean Transactions | `/clean-events` | Verified LOAN_TRANSFER rows. |
| Analysis | Private Credit | `/private-credit` | Non-bank counterparties + leaderboard. |
| Analysis | Lending Relationships | `/credit-facilities` | Lender ↔ borrower families, drill-down, CSV. |
| Analysis | UCC Filings | `/ucc` | Borrower → lender; consumer lending hidden by default. |
| Intelligence | News | `/news` | New badge. Ported morning page (TRD picks, industry/finance news, outlook, link digest). **Uncommitted in working tree** at session start. |
| Intelligence | Peers | `/peers` | New badge. Ported from Market Intelligence (deployed 28 Oct). |
| Data | Raw Assignments | `/assignments` | Unfiltered county index. |
| Data | Entities | `/entities` | Canonical list; Reclassify; Duplicate Manager (bulk). |
| Data | Collection Log | `/collection-log` | Scrape-completeness proof cards + run history. Ops health page. |

- `pages/MarketRelationships.tsx` exists (664 lines) but is **not routed** — orphan.
- Three "New" badges and one "Beta" badge currently showing at once.
- Still to be ported from Market Intelligence (per merge doc): Legal Landscape, Market Research.

**Observations worth raising** (mine, for discussion — not requests)
1. Sidebar is 15 items across 4 groups; "Analysis" alone has 8. Getting long for a 240px rail.
2. Two bank pages (FDIC Data Analytics, Bank Stress Ranking) now read the same data — overlap in purpose is visible to a user.
3. Badge fatigue: Beta + 3× New.
4. Naming inconsistency: "Clean Transactions" vs "Raw Assignments" vs "Reporting" — a new user can't tell which is the "real" table.
5. Group names (Analysis / Intelligence / Data) describe the source, not the user's question.

### Direction: "social network" model for the whole tool

Owner's framing: the tool should feel like a social network. Three anchors named so far:
1. **Notifications page** — a feed of what happened.
2. **Entity profile** — a company is a "user", with a profile page.
3. **Following = Targets** — the watchlist becomes the list of entities you follow; the feed is driven by who you follow.

**How this maps onto what exists today**

| Social concept | Exists today | Gap |
|---|---|---|
| Profile (entity) | `EntityDetailPanel` — a slide-over panel, not a page: Activity summary, Legal Vehicles (sub-entities), Acquisitions, Dispositions, Change type. Entity report (written summary) in Reporting. | No URL per entity, no header/identity block, no "follow" button, no tabs. Lending Relationships, UCC, Private Credit, Bank Stress data about the same entity live on other pages. |
| Follow / following list | Targets page (`/targets`, `/api/targets`) — search, add, watchlist table linking into Reporting. Seeded from CSV. | Follow action only on Targets page. Not reachable from where you see the entity. |
| Feed / notifications | Weekly Monday email (SHCP Market Monitor); Collection Log (ops events); Overview leaderboards. | No in-app feed, no per-event records, no read/unread, no "new since last visit". |
| Posts / activity items | Every recorded filing is already an event with a date, two parties, a type, an amount, a document link. | Not rendered as a stream; rendered as tables. |
| Trending / discover | Overview Top Acquirers / Sellers / Most Connected; Bank Stress ranking; Private Credit leaderboard. | Not framed as "who to follow". |
| Mentions / connections | Most Connected (degree) on Overview; lender↔borrower families; counterparties in entity panel. | No "mutual" / "also follows" style view. |

**Open questions for the owner**
- Q1. Who is the "user"? Per-person following (each analyst their own list) or one shared firm watchlist as Targets is today? Login is one shared password, so per-person needs a notion of identity.
- Q2. What counts as a notification? Candidates: a followed entity files anything; a followed entity's volume spikes; a new entity appears in the top 10; a bank you follow changes stress tier or lights the CRE-seller flag; a followed lender appears in a new UCC/facility; news mentions a followed name. Which are in v1?
- Q3. Profile scope: assignments only, or everything the tool knows (assignments, facilities, UCC, private-credit tag, bank stress if it is a bank, news mentions, peers data if it is a fund manager)?
- Q4. Does the feed replace Ask the Data as the landing page, or sit beside it?
- Q5. Do existing analysis pages (Reporting, Clean Transactions, etc.) stay as they are underneath, or does the social layer replace the top-level nav?
- Q6. Cadence: feed built nightly after the rebuild (matches data freshness) vs live.

**My read of the proposal** (recorded for discussion)
- Strong fit: the data is genuinely event-shaped (filing = post, entity = account), and Targets already is a follow list. Entity profile as a real page with a URL is the piece most of the other ideas hang off.
- Risk: "social" framing can over-promise freshness. Counties publish 3–6 business days late (Broward) and the rebuild is nightly; a feed must show the recording date, not imply real time.
- Suggested build order if adopted: entity profile page → follow button everywhere an entity appears → notifications feed from follows → discover/trending.

### Requested UI changes

| # | Request | Where | Discussion / open questions | Decision |
|---|---|---|---|---|
| 1 | Notifications page (activity feed) | New page | Ordering date, grouping, cadence (Q6) still open | v1 trigger = any filing by a follow (D2); shared (D1) |
| 2 | Entity profile page | Replace/extend EntityDetailPanel | Scope of data shown (Q3); URL per entity; follow button | open |
| 3 | Targets → "Following" | `/targets` | Rename; follow/unfollow from profile and tables | shared list (D1) |

### Decisions
- **D1 (28 Oct 2026): Following is one shared firm list**, not per analyst. Answers Q1. Consequences: no user identity needed; Targets table carries straight over as the follow list; read/unread state on the feed must also be shared or dropped (a per-person "unread" dot is not possible with one login) — lean towards "new since <date>" rather than read/unread.
- **D2 (28 Oct 2026): v1 notification trigger = any new filing where a followed entity is a party** (assignor or assignee; later also UCC party or facility lender/borrower). Answers Q2 for v1. Spikes, bank-stress tier changes, news mentions deferred to later layers.
  Design notes that follow from D2:
  - One feed item per filing. Content: recording date, county, document type, assignor → assignee (followed name highlighted), transaction type, amount where read, link to document image and to the entity profile.
  - Which date orders the feed? **Recorded date** (what the county says) vs **collected date** (when we got it). Broward lands 3–6 business days late; a feed sorted by recorded date would insert items "in the past". Proposal: order by collected date, display recorded date prominently. To decide.
  - Self-assignments: hide by default (consistent with Reporting), toggle to show.
  - Group or not? A servicer transfer can file hundreds in a day for one name. Proposal: collapse same-day, same-pair, same-type filings into one item with a count ("US Bank → Wells Fargo, 212 assignments, 27 Oct"). To decide.
  - Volume: Miami-Dade alone runs ~40–50k loan-transfer filings/yr. A follow list of 30 names could produce dozens of items a day; grouping matters.
  - Hidden counterparties on Reporting (MERS, Fannie, Freddie, Wilmington) — follow them or not? If followed, feed would be flooded. Proposal: allowed but off the seed list.
  - Freshness label on the feed header: "Data through <newest collected day per county>", reusing the completeness check from Collection Log.

### Session 1 paused — 28 Oct 2026, afternoon. Resumes tonight.
Pick up at: grouping of same-day bulk filings (yes/no), then feed ordering date, then profile scope (Q3), landing page (Q4), nav (Q5).

### Parking lot / follow-ups
- News port is uncommitted in the working tree — flag for the engineering session, not for this one.
- Orphan `MarketRelationships.tsx` — delete or route?

---

## Session 2 — 2026-11-03 (UI decisions made during the Complaints work; built and deployed)

- **No side drawers.** Detail cards open as a pop-out card in the middle of the screen over a dimmed background. Done for the Bank Stress bank card and the Entities/Dashboard entity card; the Peers manager card and the institution profile already were. Rule going forward: any new detail view is a centred card.
- **Bank card is expandable.** Score tiles, rank and flag chips stay visible at the top. Below them six collapsible sections (Top drivers, Trend charts, Which stress rules the bank tripped, Component percentiles, Quarterly figures, FDIC detail), all closed when the card opens, with Expand all / Collapse all.
- **Every title and column name has a hover definition.** Glossary keys `bank-card:*` plus data-driven hints for rule tests and metric formulas. Standard for new screens: no column or sub-title without a definition on hover.
- **Navigation:** top bar with hover dropdowns (Home / Analysis / Intelligence / Data) replaced the sidebar.
- **Labels:** the Complaints tab is badged "Open testing" (was Beta).
- **Complaints tab:** two views (Summary and Spreadsheet), the old Lido sheet's columns, CSV download, PDF link.
- Not yet covered by the hover/card rules: chart legends, the main Bank Stress table's secondary tables and other pages' tables. Candidates for a follow-up pass.

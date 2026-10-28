# Palm Beach County Expansion — Scope

**Status:** draft for the owner's decision · **Written:** 28 Oct 2026 · **No code written, production untouched**

> Supersedes the Palm Beach part of the 13 Oct 2026 scoping entry in `SESSION_LOG.md`. The one fact that changed since then changes the recommendation: **the county's paid FTP feed now delivers document images, not only the index.** On 13 Oct the clerk's page described a $600/yr index-only service; on 28 Oct it describes index ($1,200/yr), images ($2,400/yr) or both ($3,600/yr). With images on the feed, Palm Beach can run exactly like Broward — no portal, no captcha, no scraping — and better than Broward, because the feed keeps 45 days instead of 10.

---

## 0. In plain English

- Palm Beach's free website cannot be used by a program: every search is behind a Google reCAPTCHA that the server checks. That was confirmed on 13 Oct and has not changed. Getting around it is not recommended.
- The county sells the same data as a daily download over FTP. Since the last look, that download includes the document images. **That is the route.** It is the Broward design we already run, with a longer safety window.
- Cost: **$3,600 a year** for index plus images, billed each 15 December for the next year. Starting now costs **$600** for November–December 2026, then **$3,600 by 15 Dec 2026** for 2027. Index only is $1,200/yr, but an index without images is a repeat of Broward's problem: 41,970 Broward documents we can list but cannot read.
- The feed only goes forward from the day we subscribe. History (2023 to subscription date) is a separate, cheap index purchase ($40 per year on CD-ROM, so $120–160) plus a public-records request for the images, or we accept "index-only history" as the owner already did for Broward.
- Build effort is one session on a branch and one to go live, the same shape as Hillsborough (13 Oct). About 20 files change; the list is in §5. No database rebuild is expected.
- Four decisions are needed from the owner before anything is built (§8). The first is the subscription itself, because nothing can be built or tested until the first daily file arrives.

---

## 1. What Palm Beach offers (verified 28 Oct 2026 unless noted)

| Channel | What it gives | Cost | Usable by the pipeline? |
|---|---|---|---|
| **Landmark Web portal** `erec.mypalmbeachclerk.com` | Search + free view/print, up to 10,000 results per search | Free | **No.** Server-enforced reCAPTCHA v2 on all 13 search forms, including instrument lookup (verified 13 Oct by posting a search without a token → `Invalid Captcha`). Disclaimer accepted 13 Oct with owner authorization. No anti-automation clause in the agreement, but the captcha is a deliberate control |
| **Electronic Distribution (FTP)** — index | Daily `YYYYMMDD.dat`, pipe-delimited, up to five record types: Document Header, Party, Legal Description, **Linked Document**, cross-footing Trailer. ≥45-day retention | **$1,200/yr** (prorated $100/mo) | Yes — same shape as Broward's daily feed |
| **Electronic Distribution (FTP)** — images | TIF per document, named by clerk's file number and page number, in the same daily drop | **$2,400/yr** (prorated $200/mo) | Yes — same shape as Broward's `img.zip` entries (`<instrument>.<page>.tif`) |
| **Both** | | **$3,600/yr** (prorated $300/mo); payable 15 Dec for the following year | **Recommended** |
| **CD-ROM — index** | One calendar year of index per disc, 1968 onward | $40/yr ($400/decade) | Yes, for history. Product page 404s on 28 Oct but the fee schedule still lists it; confirm by phone (561-355-2932) |
| **CD-ROM — images** | One Official Record Book per disc | $20/book | No — assignments are scattered across thousands of books |
| **Public-records request** | Whatever is asked for; custodian decides format and cost | Per request | Yes, for history images: "assignment document images, 2023-01-01 → subscription date, TIF" — the Broward bulk-order recipe (`CONFLUENCE` §7.6 item 2) |

Contacts: Records Service Center 561-355-2932 (subscriptions, ATTN Melissa Thomas, P.O. Box 4526, West Palm Beach FL 33402; delivery 205 N. Dixie Hwy Room 4.2519) · public records `publicrecords@mypalmbeachclerk.com`, 561-355-2983 · Recording Dept 561-355-2991.

Subscription paperwork (two PDFs on the clerk's site, not yet read — the site blocks non-browser fetches): the **Subscription Agreement** (`mypalmbeachclerk.com/home/showpublisheddocument/150/…`) and the **FTP Creation Form** (`…/148/…`). Payment is by cheque, mailed or delivered. Credentials are e-mailed after payment. Read the agreement for any redistribution clause before signing; the public disclaimer has none.

**Document codes** (portal, 13 Oct): `ASSIGNMENT` (id 31), `ASSIGNMENT TAXABLE` (id 62), `FINANCING STATEMENTS (UCC'S)` (id 35). The feed's own codes are unknown until the first file; the Header record will carry them. Palm Beach also has a **Linked Document** record type, which Broward and Hillsborough lack — if it links an assignment to the mortgage it assigns, that is free assignment→mortgage linkage worth storing in `raw_json`.

**Unknowns that only the first file settles:** the exact field layout (the "File Layout" label on the clerk's page links to nothing — reverse-engineer from real files as was done for Broward, where the county's layout PDF also 404'd); the clerk's-file-number format (believed 11 digits, `YYYY` + 7, e.g. `2026XXXXXXX` — disjoint by length from Hillsborough's 10 and Broward's 9, which keeps the global `UNIQUE(cfn)` safe without the `UNIQUE(county, cfn)` rebuild; **must be confirmed before `check_county_isolation.py` gets its pattern**); daily volume; whether "internet-restricted" documents are on the feed; the size of a daily image drop.

**Volume, estimated (no county figure exists; measure from the first week of files):** Broward records ~14,000 assignments a year (CY2023–25 exactly: 14,371 / 13,925 / 13,674). Palm Beach has about 78% of Broward's population, so expect **~11,000 assignments/yr (~42,000 since 2023)** and, going by Hillsborough, **~10,000 UCC filings/yr**.

---

## 2. Why the FTP feed and not the alternatives

| Route | Verdict | Why |
|---|---|---|
| **A. FTP index + images ($3,600/yr)** | **Recommended** | Fully automatic, daily, no captcha, no scraping, 45-day recovery window. Same code shape as Broward (`broward_collect.py` + `broward_images.py`), so the build is a port, not a design. Completeness is provable from the feed's own trailer record |
| B. FTP index only ($1,200/yr) + images by hand | Not recommended | Images would need a person solving a captcha per session on the portal. Repeats Broward's unread backlog |
| C. Human-in-the-loop portal searches (one captcha per search, 10,000 rows) | Fallback only | Weekly manual work for the index, images still one-by-one. Not 24/7 (every long-running job must be droplet cron) |
| D. Captcha-solving service | **No** | Defeats an explicit access control |
| E. Defer | Possible | Nothing breaks; Palm Beach stays "deferred" on the status table |

Index-only is cheaper by $2,400/yr, but the value of this tool is the read document (assignor/assignee from the text, deal classification, facility language), none of which exists from an index row. Broward is the proof: 43,795 index rows, 41,970 unreadable.

---

## 3. History (2023 → subscription date)

The feed is forward-only. Three choices, cheapest first:

1. **Index-only history** — CD-ROM index for 2023, 2024, 2025 ($120) and, once the clerk cuts it, 2026 ($40). Documents are searchable and counted, not analysed. This is the Broward precedent the owner accepted on 21 Oct 2026.
2. **Index + images history** — item 1 plus a public-records request to `publicrecords@mypalmbeachclerk.com` for assignment (and, if wanted, UCC) images 2023-01-01 → subscription date, TIF, named by file number and page. Cost set by the custodian; ask for a quote first. ~42,000 assignment images at a guess.
3. **No history** — Palm Beach starts on the subscription date. The weekly email's 98%-read gate then admits it quickly, but every "vs prior year" figure is empty for a year.

Option 1 is the minimum worth doing: it makes the 2023+ Reporting filters and the entity histories cover the county, and it is the only way the completeness check (§5, reconcile) has something to compare the daily feed's early days against.

---

## 4. Process — who does what, in order

| # | Step | Who | Blocks |
|---|---|---|---|
| 1 | Decide §8 (route, history, UCC, start month) | Owner | Everything |
| 2 | Read the Subscription Agreement + FTP Creation Form; sign; cheque for the prorated months (Nov–Dec 2026 = $600 for both) | Owner | 3 |
| 3 | Credentials arrive by e-mail → add `PALMBEACH_FTP_HOST/USER/PASS` to `/opt/amo-dashboard/.env` (cron wrappers read `.env`; the Node server does not need them). Mirror into the PM2 dump only if a server feature ever reads them | Engineer (owner relays the e-mail) | 4 |
| 4 | **First-file study** (one session, nothing deployed): `--list` the server, pull one day's `.dat` and image set read-only, write the layout into the collector docstring as Broward's is, confirm the file-number format, the doc codes, the Linked Document record, the daily image size, and the count per record type against the trailer | Engineer | 5 |
| 5 | **Build on a branch** (`feat/palm-beach`): the §5 list, verified on a local copy with a week of real files, guardrails green, `npm run check` + build clean, normalize rehearsal diffing entity types (a new county's raw names can retype existing entities — Carrington lesson, 13 Oct) | Engineer | 6 |
| 6 | Order history (§3) in parallel with 5 | Owner orders, engineer ingests on arrival | — |
| 7 | **Go live**: owner approval → merge → deploy (pull, `npm run build`, `pm2 restart`) → install cron → first daily run watched → extraction backlog started with `nohup` | Engineer, owner approves | 8 |
| 8 | Proof: Collection Log card for Palm Beach green against the feed trailer; `check_county_isolation.py` green; Overview selector shows the county | Engineer | — |
| 9 | Weekly email: wired in but **gated** at 98% read, exactly as Hillsborough was | Automatic | — |
| 10 | Close-out: SESSION_LOG, Confluence §7 status table + §7.6 item 12 + data-sources row, memory | Engineer | — |

Timing: step 4 cannot start until credentials arrive (the clerk says they e-mail them on receipt of a correct cheque). The subscription prorates from the month **after** the request, so a request in October is billed from 1 November and the first file is 1 November at the earliest. Steps 4–5 are about two working sessions; step 7 is one.

---

## 5. Tool integration — what changes, file by file

The county model is already generic enough that Hillsborough needed no schema change; Palm Beach should need none either, provided the file-number format is disjoint. Everything below is the Hillsborough touch list (19 files) with the Broward image path instead of on-demand fetching.

### 5.1 Collector (Python, `collector/`)

| File | Change |
|---|---|
| **`palmbeach_collect.py`** (new) | Port of `broward_collect.py` for the `.dat` layout: FTP (plain `ftplib`, or `paramiko` if the clerk's server turns out to be SFTP) → parse Header/Party/Legal/Linked/Trailer → keep assignment codes (+ UCC if §8.3 stays yes) → `assignments` with `county='PALM-BEACH'`, parties in filing order, `raw_json` holding legal, linked documents, consideration, page count. `--list`, `--daily`, `--start/--end` (re-ingest a window inside the 45 days), `--history <cd-rom file>` for the CD-ROM index. Label `PALM-BEACH:{code}:{date}`. Refuse cross-county CFN collisions. **Trailer cross-footing = the completeness source** (store the trailer counts) |
| **`palmbeach_images.py`** (new) or a branch inside `broward_images.py` | Same design: selective pull of only our instruments' TIFs from the daily drop, stored under `collector/palmbeach_images/<cfn>/` as the irreplaceable artifact. If the drop is a zip, the central-directory tail trick carries over unchanged; if loose files, it is simpler. **Deadline is 45 days, not 10** — still run daily, warn at 30 days unharvested |
| `extract_pdfs.py` | Third branch beside `BROWARD` (local TIFF dir) and `HILLSBOROUGH` (on-demand PDF): `PALMBEACH_IMAGE_DIR`, availability clause in the candidate query (line ~450), classifier: assignment codes → `_CAT_GENERIC_DOC_TYPES` (generic like Broward `AST`/Hillsborough `ASG`, so rows reach analytics only once read), UCC code → `_CAT_UCC_DOC_TYPES` |
| `reconcile_counties.py` | `reconcile_palmbeach(days)`: source = the day's feed file instrument set (as Broward daily) and, for the CD-ROM years, per-day sets from the yearly index (as `reconcile_broward_years`). Verdicts into `index_coverage`; `--repair` re-ingests a short day from the feed while it is still inside 45 days |
| `normalize.py` | `'PALM-BEACH'` in the default county tuple; UCC code in `NON_ASSIGNMENT_DOC_TYPES`; address-prefix regex at line ~772 already knows "palm beach" |
| `tests/check_county_isolation.py` | `KEY_PATTERNS['PALM-BEACH']` — **the pattern must be proven from real files, and disjoint from `^\d{9}$`, `^20\d{8}$`, `^\d{4}R\d+$`.** If it overlaps (e.g. 10 digits starting `20`), this is the moment the deferred `UNIQUE(county, cfn)` rebuild becomes mandatory (ripples into `pdf_extractions`, `document_text`, `credit_facility_events`, batch tables, `/api/chat/drill`, doc links) |
| `tests/check_doc_type_scope.py`, `check_doc_category.py` | Fixture rows for the Palm Beach codes |
| **`run_palmbeach_daily.sh`** (new) | flock; `palmbeach_collect.py --daily` → `palmbeach_images.py --all` → `extract_pdfs.py --county PALM-BEACH --limit 300 --budget 1.00`; sources `.env`. Cron once a day is enough given 45-day retention, but a heartbeat into the Overview banner as Broward has (images are time-limited). Suggested `15 14 * * *` UTC, after the clerk's daily build |
| `run_backup.sh` | Add the image directory to the bucket backup (Broward's is) |

### 5.2 Server (`server/`)

| File | Change |
|---|---|
| `routes.ts` | `COUNTY_LABELS` (`'PALM-BEACH': 'Palm Beach County'`); `DOC_TYPE_FILTERS.pb_asg` for the Reporting type filter; UCC endpoints' county scoping already generic; the Hillsborough progress-card queries (lines ~368–387) have a Palm Beach counterpart only if a backlog card is wanted |
| `chat/tools.ts`, `chat/prompt.ts`, `chat/index.ts` | `normalizeCounty` accepts `PALM-BEACH`; tool descriptions list it; prompt gains the file-number format and codes; no document link rule (see client) |
| `email/rollupReport.ts` | `COUNTIES`, `COUNTY_LABEL`, `COUNTY_COLOR` (fourth colour), `READ_GATED['PALM-BEACH']` with its codes and `from: '2023-01-01'` (or the subscription date if no history). **Four counties per row — check the Outlook wrap**, the colour-coded-lines design exists because of it |

### 5.3 Client (`client/src/`)

| File | Change |
|---|---|
| `lib/county-scope.ts` | `CountyScope` union + `COUNTY_OPTIONS` entry (`isScope` derives from it) |
| `components/CountyCell.tsx` | Badge `PBC`, a fourth colour |
| `lib/doc-url.ts` | **No deep link.** Landmark serves documents by an internal id (`/Search/DocumentByDocumentId/`) that the feed does not carry, and the page is behind the captcha anyway. Return `null` with the reason text, as Broward does |
| `lib/chat-drill.ts` | County allowed in drill URLs |
| `pages/CollectionLog.tsx` | `LABEL`, `ORDER`, "checked against" text ("the county's daily FTP file and its trailer counts"); `KNOWN_GAP`-style amber line if history is index-only |
| `components/ScrapeCompleteness.tsx` | One more line |
| Reporting filter definitions, county tooltips | `Palm Beach (ASG)` filter, tooltip copy |

### 5.4 Not changed

Schema (`county` column exists; `assignments.cfn` stays globally unique if §5.1's pattern check passes) · entity resolution (spans counties on purpose) · the LLM prompt (generic assignment codes are already handled) · nightly staged normalize · backups beyond the image dir.

---

## 6. Cost and sizing

| Item | Figure | Basis |
|---|---|---|
| Subscription, Nov–Dec 2026 | **$600** | $300/mo prorated, both products |
| Subscription, CY2027 | **$3,600**, due 15 Dec 2026 | clerk's page, 28 Oct 2026 |
| History index 2023–2025 | **$120** (+$40 for 2026 when cut) | $40/yr CD-ROM, fee schedule |
| History images | **quote needed** | public-records request |
| Reading backlog (if images come) | ~**$40** OpenAI, ~70 h OCR | Hillsborough's 65k docs cost $30–40 at ~14 docs/min; Palm Beach ~60k docs 2023→ |
| Reading, steady state | ~**$15/yr** | ~20k docs/yr |
| Droplet disk | ~**6–10 GB/yr** images kept | Broward: ~14 MB/day for ~49 assignments; Palm Beach ~45/day + UCCs. 160 GB disk, 8% used |
| Droplet bandwidth | small | Only our instruments' TIFs are pulled, as Broward (0.13 MB of a 538 MB zip on 3 Aug 2026) |
| Build | 2 sessions + 1 go-live | Hillsborough took the same |

---

## 7. Risks and what guards them

- **Layout undocumented.** The clerk's "File Layout" link is dead. Reverse-engineer from real files, as Broward's was, and pin it in the collector docstring plus a fixture test.
- **"Verified" lag and out-of-order release.** The clerk releases documents as they are verified, not in recording order, so a day's file mixes recording dates and a recording date completes over several files. The collector must key by recording date from the Header, never by file name, and reconcile must tolerate a few days of fill-in — the same tolerance Broward's corrections already needed. Measure the lag per run, as `broward_images.py` does, and warn in business days.
- **File-number format overlap.** If Palm Beach numbers collide with another county's pattern, the `UNIQUE(county, cfn)` rebuild is forced. Decide from the first file, before any ingest.
- **Internet-restricted documents** may be absent from the feed or image-less. Count them from the Header record and report them on the Collection Log card so "complete" is not misread.
- **Entity retyping.** A new county's raw names can change an existing entity's type through canonical-name collisions (Carrington, 13 Oct). The normalize rehearsal on a production snapshot with an entity-type diff is mandatory before go-live.
- **Subscription lapses** (cheque not sent by 15 Dec) silently stop the feed; the 45-day window then runs out. The heartbeat banner on the Overview covers it; add the renewal date to the Confluence "needing the owner" list.
- **Images are the irreplaceable artifact** — back the directory up with the DB.

---

## 8. Decisions for the owner

1. **Subscribe?** Index + images at $3,600/yr (recommended) · index only at $1,200/yr · defer.
2. **History:** index only via CD-ROM ($120, recommended minimum) · index + a quote for 2023→ images · none.
3. **UCC filings:** the 13 Oct decision was "collect in both new counties". Still yes? (Images for them ride on the same subscription; reading them costs a few dollars.)
4. **Start month:** request now → billed from 1 Nov 2026 ($600 to year-end, then $3,600 due 15 Dec) · wait and subscribe for CY2027 only ($3,600, first file 1 Jan 2027).

Nothing in §4–§5 can begin before decision 1, and decision 1 is the owner's cheque, not an engineering step.

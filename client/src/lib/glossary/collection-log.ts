import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the collection log page. Keys are namespaced "collection-log:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  // ── Scrape-completeness proof cards (one per county) ──────────────────────
  'collection-log:Verified through': {
    definition: 'The newest recording day on which every document the county lists was confirmed to be in the tool.',
    howCalculated: 'The latest recording day whose completeness check came back OK (we hold every instrument the county lists) or AHEAD (we hold more than the county lists). A day that is short or could not be verified does not advance it.',
    whyValuable: 'This is the honest "data is current up to" date. Filings after it may well be in the tool, but they have not yet been proven complete against the county.',
  },
  'collection-log:Last checked': {
    definition: 'When the completeness check last ran for this county, and how many hours ago that was.',
    howCalculated: 'Timestamp of the most recent check row for the county. The check runs after every Miami-Dade pull, daily for all counties at 12:30 ET, and over a 14-day window every Friday. The card turns amber at 48 hours without a check.',
    whyValuable: 'A "complete" badge is only as fresh as its last check. A stale check means the pipeline that verifies the data may itself have stopped.',
  },
  'collection-log:Last collected': {
    definition: 'When documents were last pulled from this county into the tool.',
    howCalculated: 'Timestamp of the county\'s most recent collection run, from the run log at the bottom of this page.',
    whyValuable: 'Separates "we have not pulled lately" from "we pulled and it was short". Broward in particular publishes 3-6 business days late, so a recent collection with no new documents is usually the county, not the pipeline.',
  },
  'collection-log:Last 30 days': {
    definition: 'How many of the day-checks run in the last 30 days were verified complete, plus any that were short or unverifiable.',
    howCalculated: 'A day-check is one county, one recording day, one document type. Verified = OK + AHEAD. Short = the county lists instruments we do not hold. Unverifiable = the county source could not give a true count (for example a Miami-Dade portal day over its 500-row cap).',
    whyValuable: 'A quick read on recent reliability: anything other than "N of N verified" deserves a look at the red table below.',
  },
  'collection-log:Since': {
    definition: 'The same verified / short / unverifiable tally across every day-check ever run for the county, from the first recording day checked.',
    howCalculated: 'All check rows for the county, counted the same way as the 30-day figure. The history runs from 2023 for Miami-Dade and Broward and from the Hillsborough go-live for Hillsborough.',
    whyValuable: 'Answers "has the tool ever silently missed documents?" over the full history, not just the last month.',
  },

  // ── Table: documents the county lists that are not in the tool ────────────
  'collection-log:County': {
    definition: 'The county whose clerk lists the documents (Miami-Dade, Broward or Hillsborough).',
    whyValuable: 'Each county is checked against a different source of truth, and each has its own known quirks, so a gap is read per county.',
  },
  'collection-log:Recording day': {
    definition: 'The date the county clerk recorded the documents being compared. Every check is done one recording day at a time.',
    howCalculated: 'Taken from the county\'s own index, not from the document text.',
    whyValuable: 'Tells you exactly which day\'s pull fell short, and whether the shortfall is recent (likely to self-heal on the next re-collection) or old (needs a manual pull).',
  },
  'collection-log:Type': {
    definition: 'The document type code the check queried, as the county labels it (for example AOM, ASG, UCC).',
    howCalculated: 'Miami-Dade and Hillsborough are asked one document type per day; Broward\'s daily index file carries every type, so its checks cover the whole feed.',
    whyValuable: 'Shows which stream missed. A gap in a type the tool does not analyse (for example a code outside the assignment family) matters less than one in AOM.',
  },
  'collection-log:County listed': {
    definition: 'How many instruments the county lists for that recording day and document type.',
    howCalculated: 'The count of distinct instrument numbers returned by the county\'s source: the clerk\'s portal search (Miami-Dade), the daily index file (Broward) or the public search API (Hillsborough).',
    whyValuable: 'The denominator of the check. It is the county\'s own figure, so it is what an analyst would see if they searched the clerk\'s site themselves.',
  },
  'collection-log:Ours': {
    definition: 'How many of those instruments the tool holds.',
    howCalculated: 'The county\'s instrument numbers are matched one by one against the documents we hold, under any document type and any date. Counts alone are never compared.',
    whyValuable: 'The difference between this and the county\'s figure is the gap. Matching by instrument, not by count, means a day cannot pass by holding the wrong documents.',
  },
  'collection-log:Missing instruments': {
    definition: 'The instrument numbers (CFNs) the county lists that are not in the tool. The first twelve are shown; each links to the clerk\'s site where the link format is known.',
    howCalculated: 'County\'s instrument list minus ours. When a day is short, it is re-collected on the spot and checked again, so what is listed here is what that retry could not fix.',
    whyValuable: 'The claim "everything is in" is checkable: click an instrument and compare against the county directly. Use the filter box above the table to find a specific instrument number.',
  },
  'collection-log:Checked': {
    definition: 'When this day and document type was last checked against the county.',
    whyValuable: 'A short day with an old check date has survived several automatic re-collections and will need someone to look at it.',
  },

  // ── Table: day-checks that could not be verified or where we hold more ────
  'collection-log:County / Ours': {
    definition: 'The county\'s instrument count for the day beside ours. A question mark means that side could not be counted.',
    howCalculated: 'Same instrument-level comparison as the red table. Miami-Dade\'s portal returns at most 500 rows and reports no total, so a day at the cap shows as unknown rather than a false count.',
    whyValuable: 'Lets you see whether the oddity is a missing count (unverifiable) or the tool holding more than the county (ahead).',
  },
  'collection-log:Check status': {
    definition: 'The outcome of the day-check. AHEAD: we hold more instruments than the county lists. UNKNOWN: the county source could not give a true count, so the day could not be reconciled.',
    howCalculated: 'AHEAD typically comes from corrections the county has not re-indexed or documents the portal later re-recorded. UNKNOWN is usually a Miami-Dade day over the portal\'s 500-row cap.',
    whyValuable: 'Neither status is a gap, but UNKNOWN days are the ones the proof cannot vouch for, which is itself worth knowing.',
  },
  'collection-log:Note': {
    definition: 'The checker\'s explanation for the status, in its own words.',
    whyValuable: 'Saves a trip to the server log when deciding whether a day needs attention.',
  },

  // ── Collection run log ────────────────────────────────────────────────────
  'collection-log:Status': {
    definition: 'How the collection run ended. OK: everything the county returned was stored. CAPPED: the county source hit its result cap, so the window may be incomplete. EMPTY: the county reported nothing in the window (a normal answer, not a failure). ERROR: the run failed.',
    howCalculated: 'Set by the collector when the run finishes. A Miami-Dade day that any name partition could not resolve under the 500-row portal cap is logged CAPPED, never OK.',
    whyValuable: 'CAPPED and ERROR are the rows that mean the pipeline may have missed a window; the completeness proof above is what confirms whether it actually did.',
  },
  'collection-log:Date From': {
    definition: 'The first recording day the run asked the county for.',
    whyValuable: 'Together with Date To it shows the window each run covered, so gaps between consecutive runs are visible.',
  },
  'collection-log:Date To': {
    definition: 'The last recording day the run asked the county for.',
    whyValuable: 'A window that ends well before today, with no later run, is a sign the daily job has stopped.',
  },
  'collection-log:Records Found': {
    definition: 'How many documents the county returned for the window.',
    howCalculated: 'Count of records stored by that run, after de-duplicating by instrument number.',
    whyValuable: 'Zero on a weekday for a large county is unusual; a sudden drop against the usual daily volume is an early sign of a feed or portal change.',
  },
  // ── Scheduled jobs (collector health panel, 12 Nov 2026) ───────────────────
  'collection-log:Job': {
    definition: 'One scheduled job on the server: a county pull, a complaints collector, a check, the email or a backup.',
    howCalculated: 'Every entry in the server\'s crontab is listed, grouped by what it does.',
    whyValuable: 'One place to see that every part of the pipeline is still running, not just the county pulls.',
  },
  'collection-log:Schedule': {
    definition: 'When the job is meant to run, in Eastern time.',
    howCalculated: 'Converted from the server\'s UTC crontab with today\'s offset. The server does not change for daylight saving, so these times move by an hour in March and November.',
    whyValuable: 'Tells you whether a job that has not run lately is late or simply not due yet.',
  },
  'collection-log:Last run': {
    definition: 'When the job last started, and how long ago.',
    howCalculated: 'The newest "starting" line in the job\'s own log on the server. A job is marked overdue when this is older than its schedule allows (for example 27 hours for a daily job).',
    whyValuable: 'A job that silently stopped being scheduled shows up here as overdue.',
  },
  'collection-log:Result': {
    definition: 'How the last run ended: OK, failed, running, overdue or a warning.',
    howCalculated: 'Read from the job\'s "done" line (its exit code or status). A run with no "done" line after its longest normal runtime counts as failed ("did not finish"). For a failure, the error the job logged is shown underneath, with any credentials removed.',
    whyValuable: 'This is the alarm. A red row means the job ran and did not do its work, which is what happened to the Miami-Dade pull from 10 to 12 Nov 2026 while the county check kept showing the gap.',
  },
  'collection-log:Last worked': {
    definition: 'When the job last finished successfully.',
    howCalculated: 'The newest run whose "done" line reports exit 0 or status=ok.',
    whyValuable: 'For a failing job, the gap between this and now is how much work needs catching up.',
  },
  'collection-log:Recent runs': {
    definition: 'The job\'s last runs, newest on the left: green worked, red failed, grey still running.',
    howCalculated: 'Up to 14 runs, read from the tail of the job\'s log.',
    whyValuable: 'Separates a one-off failure from a job that has been failing for days.',
  },
}

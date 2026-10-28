import assert from "node:assert/strict"
import { test } from "node:test"
import {
  billStatusUrl,
  billXmlToText,
  buildFederalBillSummaryPrompt,
  dedupeActions,
  describeBillRecord,
  describeMember,
  describePassage,
  describeSourcesRead,
  hasSources,
  parseBillNumber,
  parseBillStatus,
  reportUrlFor,
  selectReportText,
  shortenAction,
} from "./legal-updates-govinfo.ts"

// Cut from GPO's BILLSTATUS-119hr7730.xml as fetched 2026-10-05, with cosponsors and actions
// trimmed. The nesting is the point: <item> inside <item> for committee activities, text formats
// and related-bill relationships, which is what broke a non-greedy matcher.
const STATUS = `<?xml version="1.0" encoding="UTF-8"?>
<billStatus>
  <bill>
    <number>7730</number>
    <originChamber>House</originChamber>
    <type>HR</type>
    <introducedDate>2026-02-26</introducedDate>
    <congress>119</congress>
    <legislationUrl>https://www.congress.gov/bill/119th-congress/house-bill/7730</legislationUrl>
    <committees>
      <item>
        <systemCode>hsju00</systemCode>
        <name>Judiciary Committee</name>
        <chamber>House</chamber>
        <activities>
          <item><name>Reported By</name><date>2026-08-27T14:17:31Z</date></item>
          <item><name>Referred To</name><date>2026-02-26T14:30:15Z</date></item>
        </activities>
      </item>
    </committees>
    <committeeReports>
      <committeeReport><citation>H. Rept. 119-783</citation></committeeReport>
    </committeeReports>
    <relatedBills>
      <item>
        <title>Bankruptcy Threshold Adjustment Act of 2026</title>
        <congress>119</congress>
        <number>3977</number>
        <type>S</type>
        <latestAction><actionDate>2026-08-10</actionDate><text>Held at the desk.</text></latestAction>
        <relationshipDetails>
          <item><type>Identical bill</type><identifiedBy>CRS</identifiedBy></item>
          <item><type>Related bill</type><identifiedBy>House</identifiedBy></item>
        </relationshipDetails>
      </item>
    </relatedBills>
    <actions>
      <item><actionDate>2026-09-28</actionDate><sourceSystem><name>Senate</name></sourceSystem><text>Passed Senate without amendment by Unanimous Consent. (consideration: CR S5123)</text><type>Floor</type></item>
      <item><actionDate>2026-09-28</actionDate><text>Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent. (consideration: CR S5123)</text><type>Floor</type><sourceSystem><code>9</code><name>Library of Congress</name></sourceSystem></item>
      <item><actionDate>2026-09-17</actionDate><text>Received in the Senate, read twice.</text><type>IntroReferral</type></item>
      <item><actionDate>2026-09-16</actionDate><text>On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H5939-5940)</text><type>Floor</type></item>
      <item><actionDate>2026-09-16</actionDate><text>Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H5939-5940)</text><type>Floor</type></item>
      <item><actionDate>2026-02-26</actionDate><text>Referred to the House Committee on the Judiciary.</text><type>IntroReferral</type></item>
      <item><actionDate>2026-02-26</actionDate><text>Introduced in House</text><type>IntroReferral</type></item>
    </actions>
    <sponsors>
      <item><bioguideId>C001118</bioguideId><fullName>Rep. Cline, Ben [R-VA-6]</fullName><party>R</party><state>VA</state><district>6</district></item>
    </sponsors>
    <cosponsors>
      <item><fullName>Rep. Correa, J. Luis [D-CA-46]</fullName></item>
      <item><fullName>Rep. Lee, Laurel M. [R-FL-15]</fullName></item>
    </cosponsors>
    <policyArea><name>Finance and Financial Sector</name></policyArea>
    <subjects>
      <legislativeSubjects>
        <item><name>Bankruptcy</name></item>
        <item><name>Small business</name></item>
      </legislativeSubjects>
      <policyArea><name>Finance and Financial Sector</name></policyArea>
    </subjects>
    <summaries>
      <summary>
        <versionCode>00</versionCode>
        <actionDate>2026-02-26</actionDate>
        <actionDesc>Introduced in House</actionDesc>
        <text><![CDATA[<p><strong>Bankruptcy Threshold Adjustment Act of 2026</strong></p><p>This bill restores changes that expired in 2024 applicable to debt limits for Subchapter&nbsp;V bankruptcies.</p>]]></text>
      </summary>
    </summaries>
    <title>Bankruptcy Threshold Adjustment Act</title>
    <textVersions>
      <item>
        <type>Received in Senate</type>
        <date>2026-09-17T04:00:00Z</date>
        <formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-119hr7730rds/xml/BILLS-119hr7730rds.xml</url></item></formats>
      </item>
      <item>
        <type>Introduced in House</type>
        <date>2026-02-26T05:00:00Z</date>
        <formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-119hr7730ih/xml/BILLS-119hr7730ih.xml</url></item></formats>
      </item>
    </textVersions>
    <latestAction>
      <actionDate>2026-09-28</actionDate>
      <text>Passed Senate without amendment by Unanimous Consent. (consideration: CR S5123)</text>
    </latestAction>
  </bill>
</billStatus>`

// ── Locating ───────────────────────────────────────────────────────────────────

test("bill numbers map to GPO's path segments", () => {
  assert.deepEqual(parseBillNumber("H.R. 7730"), { type: "hr", number: 7730 })
  assert.deepEqual(parseBillNumber("S. 5477"), { type: "s", number: 5477 })
  assert.deepEqual(parseBillNumber("H.J.Res. 12"), { type: "hjres", number: 12 })
  assert.equal(parseBillNumber("HB 759"), undefined) // Florida's form; not a federal bill
  assert.equal(parseBillNumber("H.R."), undefined)
  assert.equal(
    billStatusUrl("H.R. 7730", 119),
    "https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr7730.xml"
  )
})

test("a report citation becomes the page GPO keeps for it", () => {
  assert.equal(reportUrlFor("H. Rept. 119-783"), "https://www.govinfo.gov/content/pkg/CRPT-119hrpt783/html/CRPT-119hrpt783.htm")
  assert.equal(reportUrlFor("S. Rept. 119-12"), "https://www.govinfo.gov/content/pkg/CRPT-119srpt12/html/CRPT-119srpt12.htm")
  assert.equal(reportUrlFor("H. Conf. Rept. 119-1"), undefined)
})

// ── Reading the record ─────────────────────────────────────────────────────────

test("the record is read with its nesting respected", () => {
  const record = parseBillStatus(STATUS)!
  assert.equal(record.sponsor, "Rep. Ben Cline [R-VA-6]")
  assert.equal(record.cosponsors, 2)
  assert.equal(record.introducedOn, "2026-02-26")
  // Not "Judiciary Committee; Reported By; Referred To".
  assert.deepEqual(record.committees, ["Judiciary Committee"])
  assert.deepEqual(record.subjects, ["Bankruptcy", "Small business"])
  assert.equal(record.policyArea, "Finance and Financial Sector")
  // The relationship sits inside a nested <item>; the number and type outside it.
  assert.deepEqual(record.relatedBills, [{ number: "S. 3977", relationship: "identical bill" }])
  // The format URL sits inside a nested <item> too, and the newest version comes first.
  assert.equal(record.textVersions.length, 2)
  assert.equal(record.textVersions[0].type, "Received in Senate")
  assert.equal(record.textVersions[0].pageUrl, "https://www.govinfo.gov/content/pkg/BILLS-119hr7730rds/html/BILLS-119hr7730rds.htm")
  assert.deepEqual(record.reports, [{ citation: "H. Rept. 119-783", url: "https://www.govinfo.gov/content/pkg/CRPT-119hrpt783/html/CRPT-119hrpt783.htm" }])
  // The bill's own latest action, not the related bill's "Held at the desk".
  assert.equal(record.latestAction?.date, "2026-09-28")
  assert.match(record.latestAction?.text ?? "", /^Passed Senate without amendment/)
  assert.equal(record.legislationUrl, "https://www.congress.gov/bill/119th-congress/house-bill/7730")
})

test("the CRS summary arrives as plain text, HTML and entities resolved", () => {
  const record = parseBillStatus(STATUS)!
  assert.equal(record.summaries.length, 1)
  assert.equal(record.summaries[0].description, "Introduced in House")
  assert.equal(
    record.summaries[0].text,
    "Bankruptcy Threshold Adjustment Act of 2026\nThis bill restores changes that expired in 2024 applicable to debt limits for Subchapter V bankruptcies."
  )
})

test("floor actions the Library of Congress restates are kept once, in the chamber's words", () => {
  const record = parseBillStatus(STATUS)!
  const sept28 = record.actions.filter((a) => a.date === "2026-09-28")
  assert.equal(sept28.length, 1)
  assert.match(sept28[0].text, /^Passed Senate/)
  assert.equal(record.actions.length, 5)
  assert.equal(record.actions[0].date, "2026-09-28") // newest first
  assert.deepEqual(
    dedupeActions([
      { date: "2026-01-01", text: "Introduced in House" },
      { date: "2026-01-01", text: "Introduced in House" },
    ]),
    [{ date: "2026-01-01", text: "Introduced in House" }]
  )
})

test("members are named as a reader would", () => {
  assert.equal(describeMember("Rep. Cline, Ben [R-VA-6]"), "Rep. Ben Cline [R-VA-6]")
  assert.equal(describeMember("Sen. Young, Todd [R-IN]"), "Sen. Todd Young [R-IN]")
  assert.equal(describeMember("Rep. Correa, J. Luis [D-CA-46]"), "Rep. J. Luis Correa [D-CA-46]")
  assert.equal(describeMember("Somebody Else"), "Somebody Else")
})

test("a bill that does not parse yields nothing rather than an empty record", () => {
  assert.equal(parseBillStatus("<html>Not Found</html>"), undefined)
})

// ── The record, as cited ───────────────────────────────────────────────────────

test("passage is described per chamber, with the manner", () => {
  const record = parseBillStatus(STATUS)!
  assert.equal(describePassage(record.actions), "House 2026-09-16 (voice vote, under suspension); Senate 2026-09-28 (unanimous consent)")
  assert.equal(
    describePassage([
      { date: "2026-05-02", text: "Passed Senate with an amendment by Yea-Nay Vote. 61 - 38. Record Vote Number: 210." },
      { date: "2026-04-01", text: "On passage Passed by the Yeas and Nays: 300 - 120 (Roll no. 155)." },
    ]),
    "House 2026-04-01 (300–120); Senate 2026-05-02 (61–38)"
  )
  assert.equal(describePassage([{ date: "2026-02-26", text: "Introduced in House" }]), undefined)
})

test("actions lose the citation and the referral formula", () => {
  assert.equal(shortenAction("Passed Senate without amendment by Unanimous Consent. (consideration: CR S5123)"), "Passed Senate without amendment by Unanimous Consent")
  assert.equal(
    shortenAction("Referred to the Committee on the Judiciary, and in addition to the Committee on Financial Services, for a period to be subsequently determined by the Speaker, in each case for consideration of such provisions as fall within the jurisdiction of the committee concerned."),
    "Referred to the Committee on the Judiciary, and in addition to the Committee on Financial Services"
  )
})

test("the record line is the record's own facts, in the order a reader wants them", () => {
  const facts = describeBillRecord(parseBillStatus(STATUS)!)
  assert.deepEqual(
    facts.map((f) => f.label),
    ["Sponsor", "Cosponsors", "Introduced", "Committee", "Passed", "Last action", "Identical", "Report", "Text", "CRS summary", "Policy area"]
  )
  assert.equal(facts.find((f) => f.label === "Identical")?.value, "S. 3977")
  assert.equal(facts.find((f) => f.label === "Last action")?.value, "Passed Senate without amendment by Unanimous Consent (2026-09-28)")
  assert.equal(facts.find((f) => f.label === "CRS summary")?.url, "https://www.congress.gov/bill/119th-congress/house-bill/7730/summary")
  assert.equal(facts.find((f) => f.label === "Text")?.url, "https://www.govinfo.gov/content/pkg/BILLS-119hr7730rds/html/BILLS-119hr7730rds.htm")
})

// ── The text ───────────────────────────────────────────────────────────────────

test("the bill's XML becomes its title and sections, metadata and form left behind", () => {
  const xml = `<?xml version="1.0"?><bill><metadata><dublinCore><dc:title>119 HR 1 IH: An Act</dc:title><dc:rights>Pursuant to Title 17 Section 105 this file is in the public domain.</dc:rights></dublinCore></metadata>
<form><distribution-code>II</distribution-code><congress>119th CONGRESS</congress><current-chamber>IN THE SENATE OF THE UNITED STATES</current-chamber><official-title>To amend title 11, United States Code, to modify certain bankruptcy eligibility requirements.</official-title></form>
<legis-body><section><enum>1.</enum><header>Short title</header><text>This Act may be cited as the <quote><short-title>Test Act</short-title></quote>.</text></section><section><enum>2.</enum><header>Debt limit</header><subsection><enum>(a)</enum><text>Section 1182(1) is amended by striking <quote>$2,725,625</quote> and inserting <quote>$7,500,000</quote>.</text></subsection></section></legis-body></bill>`
  const text = billXmlToText(xml)
  assert.equal(text.split("\n")[0], "To amend title 11, United States Code, to modify certain bankruptcy eligibility requirements.")
  assert.match(text, /1\. Short title/)
  assert.match(text, /\$7,500,000/)
  assert.equal(/public domain|IN THE SENATE|119th CONGRESS/.test(text), false)
})

test("a report is taken from its purpose through its votes, contents list and budget matter left out", () => {
  const plain = [
    "Purpose and Summary.............................................. 2",
    "Background and Need for the Legislation.......................... 2",
    "Committee Oversight Findings..................................... 7",
    "Purpose and Summary",
    "H.R. 7730 amends the Bankruptcy Code by increasing the debt limit.",
    "Background and Need for the Legislation",
    "The 2020 limits expired in 2024.",
    "Committee Votes",
    "No roll call votes were taken.",
    "Committee Oversight Findings",
    "The Committee made findings.",
    "Congressional Budget Office Cost Estimate",
    "Numbers.",
  ].join("\n")
  const selected = selectReportText(plain)
  assert.equal(selected.split("\n")[0], "Purpose and Summary")
  assert.match(selected, /debt limit/)
  assert.match(selected, /No roll call votes/)
  assert.equal(/Oversight|Cost Estimate|Numbers|\.{4,}/.test(selected), false)
})

test("a report without the expected headings is taken from the top, within the cap", () => {
  const selected = selectReportText("Alpha\nBeta\nGamma", 2)
  assert.equal(selected, "Alpha Beta […]")
})

// ── The prompt ─────────────────────────────────────────────────────────────────

const BILL = { displayNumber: "H.R. 7730", title: "Bankruptcy Threshold Adjustment Act", statusLabel: "Passed House & Senate (President next)", statusDate: "2026-09-28", sponsor: "Rep. Ben Cline [R-VA6]" }

test("the prompt supplies the facts, forbids changing them, and does not ask for a search", () => {
  const prompt = buildFederalBillSummaryPrompt([BILL, { ...BILL, displayNumber: "S. 5477", title: "Federal Receivership Fairness Act" }])
  assert.match(prompt, /H\.R\. 7730 \[status: Passed House & Senate \(President next\), as of 2026-09-28, sponsor: Rep\. Ben Cline/)
  assert.match(prompt, /S\. 5477 \[.*\]: Federal Receivership Fairness Act/)
  assert.match(prompt, /do not restate, correct or change them, and do not add bills/)
  assert.match(prompt, /keyed by bill number/)
  assert.equal(/search/i.test(prompt), false)
})

test("the prompt gives the model what was read, named, and asks for nothing from memory", () => {
  const sources = new Map([
    ["H.R. 7730", { crsSummary: { description: "Introduced in House", date: "2026-02-26", text: "CRS SAYS THIS." }, reportText: "REPORT SAYS THAT.", billText: "SEC. 1. TEXT." }],
  ])
  const prompt = buildFederalBillSummaryPrompt([BILL, { ...BILL, displayNumber: "S. 5477" }], sources)
  assert.match(prompt, /Congressional Research Service summary \(Introduced in House, 2026-02-26\):\n"""\nCRS SAYS THIS\.\n"""/)
  assert.match(prompt, /Committee report, explanatory sections:\n"""\nREPORT SAYS THAT\./)
  assert.match(prompt, /Bill text:\n"""\nSEC\. 1\. TEXT\./)
  assert.match(prompt, /S\. 5477 \[.*\]: Bankruptcy Threshold Adjustment Act\n  \(no summary, report or text was available\)/)
  assert.match(prompt, /never fill it from memory/)
  assert.match(prompt, /"details"/)
})

test("the card's label names what was read", () => {
  assert.equal(describeSourcesRead({ crsSummary: { description: "", date: "", text: "x" }, billText: "y" }), "From the CRS summary and the bill text")
  assert.equal(describeSourcesRead({ crsSummary: { description: "", date: "", text: "x" }, reportText: "r", billText: "y" }), "From the CRS summary, the committee report and the bill text")
  assert.equal(describeSourcesRead({ billText: "y" }), "From the bill text")
  assert.equal(describeSourcesRead({}), undefined)
  assert.equal(hasSources({}), false)
  assert.equal(hasSources({ billText: "y" }), true)
  assert.equal(hasSources(undefined), false)
})

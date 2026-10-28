import { test } from "node:test"
import assert from "node:assert/strict"
import { firmKey, iapdSearchUrl, parseIapdHit, resolveManager, scoreCandidate, type IapdHit } from "./iapd"

/** The real hit IAPD returned for Safe Harbor on 2026-10-26, address as the JSON string it serves. */
const SAFE_HARBOR_RAW = {
  firm_source_id: "305314",
  firm_ia_sec_number: "117908",
  firm_ia_full_sec_number: "801-117908",
  firm_name: "SAFE HARBOR CAPITAL PARTNERS",
  firm_other_names: ["SAFE HARBOR CAPITAL PARTNERS", "SHE DDF1 MANAGER LLC"],
  firm_ia_scope: "ACTIVE",
  firm_ia_disclosure_fl: "N",
  firm_branches_count: 1,
  firm_ia_address_details:
    '{"officeAddress": {"street1": "2900 SW 28TH TERRACE", "street2": "SUITE 203", "city": "COCONUT GROVE", "state": "FL", "country": "United States", "postalCode": "33133"}}',
}

const hit = (over: Partial<IapdHit> & { crd: string; name: string }): IapdHit => ({
  secNumber: null,
  otherNames: [],
  scope: "ACTIVE",
  city: null,
  state: null,
  ...over,
})

const SAFE_HARBOR = { id: "safe-harbor-capital-partners", manager: "Safe Harbor Capital Partners", aliases: ["Safe Harbor Equity", "SHCP"], location: "Miami Beach, FL" }

test("a hit is parsed with the address decoded and the firm's own name dropped from its other names", () => {
  const h = parseIapdHit(SAFE_HARBOR_RAW)!
  assert.equal(h.crd, "305314")
  assert.equal(h.secNumber, "801-117908")
  assert.deepEqual(h.otherNames, ["SHE DDF1 MANAGER LLC"])
  assert.equal(h.city, "COCONUT GROVE")
  assert.equal(h.state, "FL")
  assert.equal(parseIapdHit({ firm_name: "No CRD" }), null)
  assert.equal(parseIapdHit({ firm_source_id: "1", firm_name: "Bad address", firm_ia_address_details: "{not json" })?.state, null)
})

test("firmKey folds legal suffixes and punctuation", () => {
  assert.equal(firmKey("BH3 Fund Advisors, LLC"), "bh3 fund advisors")
  assert.equal(firmKey("Rialto Capital Management, LLC"), firmKey("RIALTO CAPITAL MANAGEMENT"))
  assert.notEqual(firmKey("Safe Harbor Family Capital, LLC"), firmKey("Safe Harbor Capital Partners"))
  assert.equal(iapdSearchUrl("BH3 Fund Advisors"), "https://api.adviserinfo.sec.gov/search/firm?query=BH3%20Fund%20Advisors")
})

test("Safe Harbor resolves over its look-alikes on name and state, and the reasons say why", () => {
  // The first six of forty hits IAPD returned.
  const hits = [
    parseIapdHit(SAFE_HARBOR_RAW)!,
    hit({ crd: "317547", name: "SAFE HARBOR FAMILY CAPITAL, LLC", secNumber: "801-122963", state: "NJ" }),
    hit({ crd: "289428", name: "SAFE HARBOR CAPITAL ADVISERS, INC.", scope: "INACTIVE" }),
    hit({ crd: "164702", name: "FIDUCIARY WEALTH", otherNames: ["SAFE HARBOR WEALTH", "SAFE HARBOR CAPITAL MANAGEMENT LLC"] }),
    hit({ crd: "342731", name: "HARBOR CAPITAL PARTNERS, LLC" }),
    hit({ crd: "129165", name: "SHS SECURITIES, INC.", scope: null, otherNames: ["SAFE HARBOR SECURITIES, INC."] }),
  ]
  const r = resolveManager(SAFE_HARBOR, [], hits, 40)
  assert.equal(r.status, "resolved")
  assert.equal(r.best?.hit.crd, "305314")
  assert.ok(r.best!.score >= 80, `name + state + active: ${r.best!.score}`)
  assert.match(r.best!.reasons.join("; "), /registry's "Safe Harbor Capital Partners"/)
  assert.match(r.best!.reasons.join("; "), /office in FL/)
  const inactive = r.candidates.find((c) => c.hit.crd === "289428")!
  assert.ok(inactive.score < 30, "an inactive near-namesake does not compete")
})

test("an exact match on the Form D's GP or investment-manager entity resolves a manager IAPD cannot find by name", () => {
  // "BH3 Management" returned nothing; its Form D names BH3 Fund Advisors, LLC as investment manager.
  const bh3 = { id: "bh3-management", manager: "BH3 Management", aliases: ["BH3"], location: "Fort Lauderdale, FL" }
  const hits = [hit({ crd: "999001", name: "BH3 FUND ADVISORS, LLC", secNumber: "802-123456", state: "FL" })]
  const r = resolveManager(bh3, ["BH3 Debt Opportunity Fund II GP, LLC", "BH3 Fund Advisors, LLC"], hits, 1)
  assert.equal(r.status, "resolved")
  assert.equal(r.best?.hit.crd, "999001")
  assert.match(r.best!.reasons[0], /Form D lists as GP or investment manager/)
})

test("two strong candidates are ambiguous, and a capped result set is ambiguous without a strong match", () => {
  // Two active advisers with the same name in the same state: nothing to choose between.
  const two = [
    hit({ crd: "1", name: "RIALTO CAPITAL MANAGEMENT", state: "FL" }),
    hit({ crd: "2", name: "RIALTO CAPITAL MANAGEMENT, LLC", state: "FL" }),
  ]
  const rialto = { id: "rialto", manager: "Rialto Capital Management", aliases: ["Rialto"], location: "Miami, FL" }
  const a = resolveManager(rialto, [], two, 2)
  assert.equal(a.status, "ambiguous")
  assert.match(a.note, /Top two within/)

  // Blackstone: 54 matched, 20 returned, none an exact registry name.
  const blackstone = { id: "blackstone", manager: "Blackstone", aliases: ["BREDS", "BCRED"], location: "New York, NY" }
  const twenty = Array.from({ length: 20 }, (_, i) => hit({ crd: `b${i}`, name: `BLACKSTONE ISG-${i} ADVISORS L.L.C.`, state: "NY" }))
  const b = resolveManager(blackstone, [], twenty, 54)
  assert.equal(b.status, "ambiguous")
  assert.match(b.note, /matched 54 advisers and returned 20/)
})

test("no hit, or only weak ones, is 'none' with a reason — never a guess", () => {
  const gelt = { id: "gelt", manager: "Gelt Financial", aliases: [], location: "Boca Raton, FL" }
  assert.equal(resolveManager(gelt, [], [], 0).status, "none")
  const naso = { id: "naso", manager: "Naso", aliases: [], location: "Miami, FL" }
  const weak = [hit({ crd: "32381", name: "RICHARD C. NASO CO., INC.", scope: null }), hit({ crd: "292830", name: "NASON HILL WEALTH MANAGEMENT INC.", scope: "INACTIVE" })]
  const r = resolveManager(naso, [], weak, 2)
  assert.equal(r.status, "none")
  assert.match(r.note, /none above 60/)
})

test("the same CRD seen in several searches is scored once, at its best", () => {
  const same = hit({ crd: "159998", name: "RIALTO CAPITAL MANAGEMENT, LLC", state: "FL", otherNames: ["RSSF GP, LLC"] })
  const rialto = { id: "rialto", manager: "Rialto Capital Management", aliases: [], location: "Miami, FL" }
  const r = resolveManager(rialto, ["RSSF GP, LLC"], [same, same, same], 1)
  assert.equal(r.candidates.length, 1)
  assert.equal(r.status, "resolved")
  const s = scoreCandidate(rialto, ["RSSF GP, LLC"], same)
  assert.match(s.reasons.join("; "), /lists "RSSF GP, LLC" among its other names/)
})

test("a registry name with a management suffix resolves; a different business with the same prefix does not", () => {
  // IAPD's two Starwood hits on 2026-10-26: the adviser and a broker-dealer shell.
  const starwood = { id: "starwood", manager: "Starwood Capital", aliases: ["Starwood"], location: "Miami Beach, FL" }
  const hits = [
    hit({ crd: "110148", name: "STARWOOD CAPITAL GROUP MANAGEMENT, L.L.C.", secNumber: "801-56403", city: "MIAMI BEACH", state: "FL" }),
    hit({ crd: "146057", name: "STARWOOD CAPITAL, L.L.C.", scope: null }),
  ]
  const r = resolveManager(starwood, [], hits, 2)
  assert.equal(r.status, "resolved")
  assert.equal(r.best?.hit.crd, "110148")
  assert.match(r.best!.reasons[0], /management suffix/)

  const sh = scoreCandidate(SAFE_HARBOR, [], hit({ crd: "317547", name: "SAFE HARBOR FAMILY CAPITAL, LLC", state: "FL" }))
  assert.ok(!sh.reasons.some((x) => /management suffix/.test(x)), "family capital is not a management suffix")
})

test("an alias listed as a relying adviser in parentheses still matches exactly", () => {
  const hig = { id: "hig", manager: "H.I.G. Capital (Bayside)", aliases: ["Bayside Capital", "H.I.G. Bayside"], location: "Miami, FL" }
  const h = hit({ crd: "160711", name: "H.I.G. CAPITAL, LLC", secNumber: "801-74338", city: "MIAMI", state: "FL", otherNames: ["BAYSIDE CAPITAL, INC. (RELYING ADVISOR)", "WHITEHORSE CAPITAL MANAGEMENT, LLC (RELYING ADVISOR)"] })
  const s = scoreCandidate(hig, [], h)
  assert.match(s.reasons.join("; "), /lists "BAYSIDE CAPITAL, INC\. \(RELYING ADVISOR\)" among its other names/)
  assert.equal(resolveManager(hig, [], [h], 59).status, "resolved", "a capped result set is fine once one hit is strong")
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { distinctiveWords, nameMatch } from "./entity-website-suggest"

test("distinctive words drop the generic ones", () => {
  assert.deepEqual(distinctiveWords("STORMFIELD CAPITAL"), ["stormfield"])
  assert.deepEqual(distinctiveWords("RESCUE LEND FINANCIAL"), ["rescue", "lend"])
  assert.deepEqual(distinctiveWords("ACQUISITION CAPITAL"), ["acquisition"])
  assert.deepEqual(distinctiveWords("CAPITAL FUNDING GROUP"), [])
})

test("name match uses the domain and the page title", () => {
  assert.equal(nameMatch("STORMFIELD CAPITAL", "www.stormfieldcapital.com", ""), 1)
  assert.equal(nameMatch("RESCUE LEND FINANCIAL", "rescuelend.com", ""), 1)
  assert.equal(nameMatch("EMCAP LENDING", "www.example.com", "EMCAP Lending | Bridge loans"), 1)
  assert.equal(nameMatch("MIDWOOD CAPITAL PARTNERS", "www.otherfirm.com", "Other Firm"), 0)
  assert.equal(nameMatch("CAPITAL FUNDING GROUP", "capitalfunding.com", ""), null)
})

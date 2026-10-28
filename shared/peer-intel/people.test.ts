import { test } from "node:test"
import assert from "node:assert/strict"
import type { ManagerRaises } from "./cohort"
import type { RelatedPerson } from "./form-d"
import { buildPeopleIndex, managerPeople, personKey, sharedPeople } from "./people"

/** Only the fields the people module reads. */
function manager(peerId: string, name: string, vehicles: Array<[string, RelatedPerson[]]>): ManagerRaises {
  return {
    peerId,
    manager: name,
    raises: vehicles.map(([vehicleName, relatedPersons], i) => ({
      cik: `${peerId}-${i}`,
      vehicleName,
      role: "fund",
      raise: { relatedPersons },
    })),
  } as unknown as ManagerRaises
}

const person = (name: string, roles: string[], clarification: string | null = null): RelatedPerson => ({ name, kind: "person", relationships: roles, clarification })
const entity = (name: string, roles: string[]): RelatedPerson => ({ name, kind: "entity", relationships: roles, clarification: null })

test("names fold case, punctuation and accents — and nothing else", () => {
  assert.equal(personKey({ name: "José  O'Neil", kind: "person" }), personKey({ name: "jose o neil", kind: "person" }))
  assert.notEqual(personKey({ name: "H. Jack Miller", kind: "person" }), personKey({ name: "Jack Miller", kind: "person" }), "a dropped initial may be a different person")
  assert.notEqual(personKey({ name: "Acme", kind: "person" }), personKey({ name: "Acme", kind: "entity" }), "a person never matches an entity")
})

test("a person on several of one manager's funds is listed once, with every fund and role", () => {
  const m = manager("shcp", "Safe Harbor", [
    ["Fund 3", [person("Rafael Serrano", ["Executive Officer"])]],
    ["Fund 4", [person("Rafael Serrano", ["Executive Officer", "Director"], "Manager of the GP"), entity("SHE DDF4 GP, LLC", ["Promoter"])]],
  ])
  const people = managerPeople(m, buildPeopleIndex([m]))
  assert.equal(people.length, 2)
  assert.deepEqual(people[0], {
    name: "Rafael Serrano",
    kind: "person",
    roles: ["Executive Officer", "Director"],
    clarifications: ["Manager of the GP"],
    vehicles: ["Fund 3", "Fund 4"],
    elsewhere: [],
  })
  assert.equal(people[1].kind, "entity", "people before entities")
})

test("the same name at another manager is a cross-manager link, with that manager's funds and roles", () => {
  const a = manager("alpha", "Alpha Credit", [["Alpha Fund I", [person("Dana Whitfield", ["Executive Officer"]), person("Sam Ortiz", ["Director"])]]])
  const b = manager("beta", "Beta Lending", [["Beta Fund II", [person("dana whitfield", ["Promoter"])]]])
  const index = buildPeopleIndex([a, b])
  const alphaPeople = managerPeople(a, index)
  assert.equal(alphaPeople[0].name, "Dana Whitfield", "anyone with a link sorts first")
  assert.deepEqual(alphaPeople[0].elsewhere, [{ peerId: "beta", manager: "Beta Lending", vehicles: ["Beta Fund II"], roles: ["Promoter"] }])
  assert.deepEqual(alphaPeople[1].elsewhere, [])
  assert.deepEqual(sharedPeople(index), [{ key: "person:dana whitfield", name: "dana whitfield", managers: ["Alpha Credit", "Beta Lending"] }])
})

test("entries cached before `kind` existed are read as people, and a manager with none is empty", () => {
  const legacy = { name: "Old Entry", relationships: ["Director"] } as unknown as RelatedPerson
  const m = manager("old", "Old Manager", [["Old Fund", [legacy]]])
  assert.equal(managerPeople(m, buildPeopleIndex([m]))[0].kind, "person")
  const empty = manager("none", "No Filings", [])
  assert.deepEqual(managerPeople(empty, buildPeopleIndex([empty])), [])
})

test("one fund's people, as its expanded row shows them: that fund only, with matches elsewhere kept", () => {
  const a = manager("alpha", "Alpha Credit", [
    ["Alpha Fund I", [person("Dana Whitfield", ["Executive Officer"])]],
    ["Alpha Fund II", [person("Sam Ortiz", ["Director"])]],
  ])
  const b = manager("beta", "Beta Lending", [["Beta Fund II", [person("Dana Whitfield", ["Promoter"])]]])
  const index = buildPeopleIndex([a, b])
  // The drawer passes the manager narrowed to the clicked fund.
  const fundOne = managerPeople({ ...a, raises: [a.raises[0]] }, index)
  assert.deepEqual(fundOne.map((p) => p.name), ["Dana Whitfield"], "Fund II's people are not listed under Fund I")
  assert.equal(fundOne[0].elsewhere[0]?.manager, "Beta Lending", "the cross-manager match still shows")
  const fundTwo = managerPeople({ ...a, raises: [a.raises[1]] }, index)
  assert.deepEqual(fundTwo[0].elsewhere, [], "and its own sibling fund is not reported as 'elsewhere'")
})

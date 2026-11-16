import { test } from "node:test"
import assert from "node:assert/strict"
import { iconLinks, imageWidth, toDomain } from "./entity-logos"

test("website text becomes a public host name; private or odd input is refused", () => {
  assert.equal(toDomain("https://www.AmerantBank.com/personal"), "www.amerantbank.com")
  assert.equal(toDomain("amerantbank.com"), "amerantbank.com")
  assert.equal(toDomain("www.amerantbank.com."), "www.amerantbank.com")
  for (const bad of ["localhost", "http://localhost:5050", "127.0.0.1", "http://10.0.0.5/", "ftp://x.com", "intranet", "a.local", "https://user:pw@x.com", "x.com:8080", ""]) {
    assert.equal(toDomain(bad), null, bad)
  }
})

test("icon links: apple-touch-icon first, then larger sizes; relative hrefs resolved", () => {
  const html = `<link rel="icon" href="/favicon-16.png" sizes="16x16"><link rel="icon" href="/favicon-32.png" sizes="32x32">
    <link rel="apple-touch-icon" href="img/apple.png"><link rel="mask-icon" href="/mask.svg">`
  assert.deepEqual(iconLinks(html, "https://bank.com/home/"), [
    "https://bank.com/home/img/apple.png", "https://bank.com/favicon-32.png", "https://bank.com/favicon-16.png",
  ])
})

test("image widths from file headers", () => {
  const png = Buffer.alloc(32); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(180, 16)
  assert.equal(imageWidth(png, "image/png"), 180)
  const ico = Buffer.alloc(40); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(2, 4); ico[6] = 16; ico[22] = 48
  assert.equal(imageWidth(ico, "image/x-icon"), 48)
  assert.equal(imageWidth(Buffer.from("<svg/>"), "image/svg+xml"), 0)
})

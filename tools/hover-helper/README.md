# AMO Complaint Intake Helper (Chrome add-on)

Used from the tool's **Data → Manual Complaint Intake** page:

- **Hillsborough (HOVER):** fills HOVER's case-number search (Year, Court Type, Number) when you click **Find in HOVER**.
- **Broward Clerk** (added 17 Nov 2026): on the search page, a banner says the case number is filled in (the Clerk's
  own page fills it from the link) and to click Search. On the case page, a banner shows the **Case Type**
  (red "Skip it" for Homestead) and the **Complaint** line on the docket is highlighted and scrolled into view.
  **v1.2 (17 Nov 2026):** the banner says "Open the Complaint, click All pages, then Download" — the Clerk's
  viewer otherwise saves only the page on screen, and the tool refuses a 1-page upload. People re-download the
  helper from the intake page and reload it in `chrome://extensions`.
  **Not yet verified:** the case-page banner has not been seen on a real Broward case page (needs a person past
  the Clerk's human check); the search-page banner is verified.

You still pass the Clerk's check, click **Search**, open the case and download yourself. The add-on never clicks,
searches, downloads or sends data anywhere; on the case page it only reads what is already on screen.

## Install (once per person, about 2 minutes)

1. On the Manual Complaint Intake page, click **Get the Chrome helper** to download `hover-helper.zip`.
2. Unzip it (double-click). Keep the `hover-helper` folder somewhere permanent, e.g. Documents.
3. In Chrome, open `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and choose the `hover-helper` folder.

Chrome may show a note about developer-mode add-ons when it starts; that is expected.

## How it works

The tool opens `https://hover.hillsclerk.com/html/case/caseSearch.html?amo_case=<case>#nav-CaseNumber-tab`.
`fill-case-search.js` runs only on that HOVER page, reads `amo_case`, and fills the three boxes.
Without the add-on the same link still opens HOVER's search, and the Number is on the clipboard.

Broward: the tool opens `https://www.browardclerk.org/Web2/CaseSearchECA/Index/?AccessLevel=ANONYMOUS&CitationNumber=CACE26018535&amo=1`.
The Clerk's page itself reads `CitationNumber` (their name; it fills the Case Number box) and wants no dashes.
`broward-clerk.js` runs on `/Web2/CaseSearchECA/*`: the banner on the search page only when `amo=1`; on any case
page it finds "Case Type" and docket lines saying "Complaint" by their words, not fixed positions.

## Rebuild the zip after a change

```bash
cd tools && rm -f hover-helper.zip && zip -r hover-helper.zip hover-helper -x '*.DS_Store'
```

Bump `version` in `manifest.json`; people then click the reload arrow on the add-on in `chrome://extensions`.

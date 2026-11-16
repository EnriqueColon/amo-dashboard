# AMO Complaint Intake Helper (Chrome add-on)

Fills HOVER's case-number search (Year, Court Type, Number) when you click **Find in HOVER** on the
tool's **Data → Manual Complaint Intake** page. You still click **Search** yourself; the add-on does
nothing else: it does not search, read results, download, or send data anywhere.

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

## Rebuild the zip after a change

```bash
cd tools && rm -f hover-helper.zip && zip -r hover-helper.zip hover-helper -x '*.DS_Store'
```

Bump `version` in `manifest.json`; people then click the reload arrow on the add-on in `chrome://extensions`.

// AMO Complaint Intake Helper — fills HOVER's case-number search boxes.
//
// The AMO tool's "Find in HOVER" button opens
//   https://hover.hillsclerk.com/html/case/caseSearch.html?amo_case=26-CA-011777#nav-CaseNumber-tab
// This script reads amo_case, switches to the Case Number tab, and fills Year, Court Type and Number.
// It never clicks Search, never reads results and never sends anything anywhere: the person does the search.
(function () {
  const raw = new URLSearchParams(location.search).get('amo_case');
  if (!raw) return;
  const m = /^(\d{2,4})-([A-Z]{2})-(\d{1,7})/i.exec(raw.trim());
  if (!m) return;
  const want = { year: m[1].slice(-2), type: m[2].toUpperCase(), number: m[3].padStart(6, '0').slice(-6) };

  const set = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const banner = (text, ok) => {
    let b = document.getElementById('amo-helper-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'amo-helper-banner';
      b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:10px 14px;border-radius:8px;' +
        'font:600 14px/1.3 system-ui,sans-serif;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:340px';
      document.body.appendChild(b);
    }
    b.style.background = ok ? '#047857' : '#b45309';
    b.textContent = text;
  };

  let tries = 0;
  const attempt = () => {
    tries++;
    // The Case Number tab's form is loaded into the page after it opens.
    const tab = document.getElementById('nav-CaseNumber-tab');
    if (tab && !tab.classList.contains('active')) tab.click();
    const year = document.getElementById('txtYear');
    const type = document.getElementById('ddlCourtType');
    const number = document.getElementById('txtNumber');
    if (year && type && number) {
      set(year, want.year);
      if ([...type.options].some(o => o.value === want.type)) set(type, want.type);
      set(number, want.number);
      number.focus();
      banner(`Filled ${want.year}-${want.type}-${want.number}. Click Search.`, true);
      return;
    }
    if (tries < 60) setTimeout(attempt, 250);
    else banner(`Could not find HOVER's case-number boxes. Fill by hand: Year ${want.year}, Court Type ${want.type}, Number ${want.number}.`, false);
  };
  attempt();
})();

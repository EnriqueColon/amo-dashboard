// AMO Complaint Intake Helper — Broward Clerk pages (owner, 17 Nov 2026).
//
// Search page: the AMO tool's "Find in Broward Clerk" button opens
//   https://www.browardclerk.org/Web2/CaseSearchECA/Index/?AccessLevel=ANONYMOUS&CitationNumber=CACE26018535&amo=1
// The Clerk's own page reads CitationNumber, opens the Case Number tab and fills the box (that works
// without this add-on). This script only adds a banner telling the person to click Search.
//
// Case page: once the person opens a case, this script reads what is already on screen and
//   - shows a banner with the Case Type: Homestead -> "Skip it"; anything else -> "Download the Complaint";
//   - highlights the docket line(s) for the Complaint so nobody has to scroll and search.
// It never clicks, never searches, never downloads and never sends anything anywhere.
(function () {
  const BANNER_ID = 'amo-helper-banner';

  const banner = (html, tone) => {
    let b = document.getElementById(BANNER_ID);
    if (!b) {
      b = document.createElement('div');
      b.id = BANNER_ID;
      b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:10px 14px;border-radius:8px;' +
        'font:600 14px/1.35 system-ui,sans-serif;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:380px';
      document.body.appendChild(b);
    }
    b.style.background = tone === 'ok' ? '#047857' : tone === 'skip' ? '#b91c1c' : '#b45309';
    b.innerHTML = html + '<div style="font-weight:400;font-size:11px;opacity:.85;margin-top:4px">AMO helper · click to hide</div>';
    b.onclick = () => b.remove();
  };

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const params = new URLSearchParams(location.search);

  // ---- Search page -------------------------------------------------------------------------
  if (/\/CaseSearchECA\/Index/i.test(location.pathname)) {
    if (params.get('amo') !== '1') return;
    const box = document.getElementById('CaseNumber');
    if (box && box.value) {
      box.focus();
      banner(`Case number ${esc(box.value)} is filled in. Complete the check if shown, then click <u>Search</u>.`, 'ok');
    }
    return;
  }

  // ---- Case page ---------------------------------------------------------------------------
  // The page layout is read by its words, not fixed positions, so small layout changes don't break it.
  let tries = 0;
  const caseType = () => {
    // A label "Case Type" followed by its value: in the same row/definition, or the next element.
    const labels = [...document.querySelectorAll('th,td,dt,label,strong,b,span,div')]
      .filter(el => el.children.length <= 1 && /^\s*case\s*type\s*:?\s*$/i.test(el.textContent || ''));
    for (const el of labels) {
      const sib = el.nextElementSibling;
      const v = sib && (sib.textContent || '').trim();
      if (v) return v;
      const row = el.closest('tr');
      if (row) {
        const cells = [...row.children];
        const i = cells.indexOf(el.closest('td,th'));
        if (i >= 0 && cells[i + 1] && cells[i + 1].textContent.trim()) return cells[i + 1].textContent.trim();
      }
    }
    // Fallback: "Case Type: X" written inline.
    const m = /case\s*type\s*:\s*([^\n]{3,120})/i.exec(document.body.innerText || '');
    return m ? m[1].trim() : null;
  };

  const markComplaints = () => {
    // Docket lines whose description is the Complaint itself (not summonses, cover sheets or notices about it).
    const rows = [...document.querySelectorAll('tr, li, .row')].filter(r => {
      const t = (r.innerText || '').replace(/\s+/g, ' ');
      if (t.length > 400) return false; // a container, not one docket line
      return /\b(amended\s+|verified\s+)?complaint\b/i.test(t) &&
        !/summons|cover\s*sheet|civil\s*cover|notice\s+of|answer\s+to|motion|order|affidavit|certificate/i.test(t);
    });
    const leaves = rows.filter(r => !rows.some(o => o !== r && r.contains(o)));
    leaves.forEach((r, i) => {
      r.style.outline = '3px solid #f59e0b';
      r.style.background = '#fef3c7';
      if (i === 0) {
        r.setAttribute('data-amo-complaint', '1');
        r.scrollIntoView({ block: 'center' });
      }
    });
    return leaves.length;
  };

  const attempt = () => {
    tries++;
    const type = caseType();
    if (!type) {
      if (tries < 40) return setTimeout(attempt, 250);
      return; // not a case page (results list, other pages): stay quiet
    }
    const homestead = /homestead/i.test(type) && !/non[\s-]*homestead/i.test(type);
    const found = markComplaints();
    if (homestead) {
      banner(`Case Type: ${esc(type)}<br>Homestead can't qualify. Back in the AMO tool, choose <u>Skip → Homestead</u>.`, 'skip');
    } else if (found) {
      banner(`Case Type: ${esc(type)}<br>Open the <u>Complaint</u> (highlighted below), click <u>All pages</u>, then <u>Download</u>, and drag it onto the row in the AMO tool.`, 'ok');
    } else {
      banner(`Case Type: ${esc(type)}<br>No Complaint found on the docket yet. If it isn't there, choose <u>Skip → Not online yet</u>.`, 'warn');
    }
  };
  attempt();
})();

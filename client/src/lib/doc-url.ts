/**
 * Per-county links to the original recorded document.
 *
 * Every county addresses its documents differently, and getting this wrong is
 * worse than showing nothing: a Miami-Dade book/page URL built from a Broward
 * row resolves to a real but UNRELATED Miami-Dade document, which looks like
 * working evidence.
 *
 * Miami-Dade — addressed by book/page, served directly as a PDF.
 * Broward     — NO public deep link exists. Images are addressed by an internal
 *               AcclaimWeb docId that appears only as a checkbox value in search
 *               results, the image endpoint requires session state established
 *               by the search flow, and the site is behind Cloudflare bot
 *               management. Four GET patterns against
 *               SearchTypeInstrumentNumber were tested and none prefill.
 *               So there is nothing honest to link to, and callers render the
 *               instrument number as plain text.
 *
 * When a working Broward deep link is found, this is the single place to add it.
 */

export type DocRef = {
  county?: string | null;
  rec_book?: string | null;
  rec_page?: string | null;
};

const MIAMI_DADE_DOC_URL =
  'https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage';

/** Returns a URL to the recorded document, or null when the county has none. */
export function documentUrl(ref: DocRef): string | null {
  const county = (ref.county || 'MIAMI-DADE').toUpperCase();
  if (county !== 'MIAMI-DADE') return null;

  const book = (ref.rec_book ?? '').toString().trim();
  const page = (ref.rec_page ?? '').toString().trim();
  // Miami-Dade addresses documents by book/page; without both there is no URL
  // to build, and a partial one silently returns the wrong document.
  if (!book || !page) return null;

  return `${MIAMI_DADE_DOC_URL}?redact=false&sBook=${encodeURIComponent(book)}`
       + `&sBookType=O+&sPage=${encodeURIComponent(page)}`;
}

/** Why no link is shown — surfaced as a title attribute so it is not a mystery. */
export function noDocumentUrlReason(ref: DocRef): string {
  const county = (ref.county || 'MIAMI-DADE').toUpperCase();
  if (county === 'BROWARD') {
    return 'Broward does not publish a direct document link — search this '
         + 'instrument number at officialrecords.broward.org';
  }
  return 'No book/page recorded for this document, so the county portal cannot address it';
}

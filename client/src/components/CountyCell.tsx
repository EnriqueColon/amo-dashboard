/**
 * The county a row's document was recorded in.
 *
 * Shared rather than repeated per page so all five document tables (Reporting,
 * Clean Transactions, Raw Assignments, Private Credit, Credit Facilities) label
 * the county identically — five hand-rolled versions would drift, and this is a
 * provenance field, where a subtle difference in presentation between tables is
 * exactly the kind of thing that erodes trust in the numbers.
 *
 * Why it matters even though a county selector already exists: under "All
 * Counties" every row is unlabelled, so a Broward instrument number and a
 * Miami-Dade CFN sit in the same column with nothing to tell them apart. The
 * two counties' records are NOT equivalent — Broward's history is index-only —
 * so knowing which county a row came from changes how much you can conclude
 * from it.
 *
 * NULL means Miami-Dade: rows predating the county column were all Miami-Dade,
 * which is the same convention the server applies (routes.ts countyPredicate).
 */

const STYLES: Record<string, string> = {
  'MIAMI-DADE': 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  'BROWARD':    'bg-violet-500/10 text-violet-600 dark:text-violet-400',
};

const SHORT: Record<string, string> = {
  'MIAMI-DADE': 'M-D',
  'BROWARD':    'BRO',
};

export function CountyCell({ county }: { county?: string | null }) {
  const c = (county || 'MIAMI-DADE').toUpperCase();
  return (
    <span
      title={c === 'MIAMI-DADE' ? 'Miami-Dade County' : c === 'BROWARD' ? 'Broward County' : c}
      className={`inline-block rounded px-1 py-0.5 text-[9px] font-semibold tracking-wide ${
        STYLES[c] ?? 'bg-muted text-muted-foreground'
      }`}
    >
      {SHORT[c] ?? c}
    </span>
  );
}

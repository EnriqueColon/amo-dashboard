import { Info } from 'lucide-react';
import { useCounty } from '@/lib/county';

/**
 * Marks a panel whose figures ignore the county selector.
 *
 * `entity_nodes` / `entity_relationships` are keyed by entity rather than by
 * document — normalize.py collapses every filing for a company into a single
 * row, so there is no county left to filter on. Rebuilding them per county is a
 * pipeline change, and one that would undercut cross-county entity resolution:
 * the same lenders trade in both counties and seeing them as one entity is the
 * point.
 *
 * Rendered only when a specific county is selected. On "All Counties" the
 * figures already match the selector, so the note would be noise.
 */
export default function CrossCountyNote({ className = '' }: { className?: string }) {
  const { county } = useCounty();
  if (county === 'ALL') return null;

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] text-muted-foreground ${className}`}
      title={'Entity totals are keyed by company rather than by filing, so they are not '
           + 'split by county. This panel covers every county in the dataset regardless '
           + 'of the county selected.'}
    >
      <Info size={10} className="shrink-0" />
      not filtered by county
    </span>
  );
}

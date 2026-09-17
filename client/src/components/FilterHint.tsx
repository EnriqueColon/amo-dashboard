import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Definition } from '@/lib/filterDefinitions';

/**
 * Hover definition for a filter or view button. Wraps the existing button
 * (via asChild) so its click behaviour and styling are untouched.
 *
 * Replaces the native `title` attribute these buttons used to carry: that
 * appears only after a long delay, can't be styled, and on several buttons
 * explained the implementation ("the extractor read as…") rather than the
 * market meaning. Don't put a `title` on the wrapped element as well, or the
 * browser shows both.
 */
export function FilterHint({ def, extra, children }: {
  def: Definition | undefined;
  /** Optional live detail appended under the definition, e.g. a count. */
  extra?: string;
  children: ReactElement;
}) {
  if (!def) return children;
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-left">
        <p className="text-xs font-semibold mb-0.5">{def.title}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{def.body}</p>
        {extra && <p className="text-[10px] mt-1 text-muted-foreground/80">{extra}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

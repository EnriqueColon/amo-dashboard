import { useState } from 'react';
import { Info } from 'lucide-react';

/**
 * Table column header with a hover tooltip.
 * Wrap any <th> label with this to give users an instant definition.
 */
export default function ColHeader({ label, tooltip }: { label: React.ReactNode; tooltip: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex items-center gap-1 cursor-default">
      <span>{label}</span>
      <span
        className="text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-help"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        <Info size={10} />
      </span>
      {show && (
        <span className="absolute top-full left-0 mt-1.5 z-50 w-60 bg-popover border border-border rounded-lg px-3 py-2 text-[11px] font-normal text-muted-foreground shadow-xl pointer-events-none leading-relaxed whitespace-normal">
          {tooltip}
        </span>
      )}
    </span>
  );
}

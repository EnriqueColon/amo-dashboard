import type { ReactNode } from 'react';
import { documentUrl, noDocumentUrlReason, type DocRef } from '@/lib/doc-url';

/**
 * Links to the original recorded document when the county publishes one, and
 * renders plain text when it does not.
 *
 * Centralised on purpose: building a Miami-Dade book/page URL from a Broward row
 * produces a real but unrelated document, which is indistinguishable from
 * working evidence. Every call site therefore goes through documentUrl(), and
 * the county with no deep link degrades to text with an explanatory title rather
 * than to a wrong link.
 */
export default function DocLink({
  row, children, className, title, onClick,
}: {
  row: DocRef;
  children: ReactNode;
  className?: string;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const url = documentUrl(row);

  if (!url) {
    // onClick is still attached: several call sites use it to stop the click
    // bubbling into an expandable row, and that has to keep working whether or
    // not the county publishes a link.
    return (
      <span className={className} title={noDocumentUrlReason(row)} onClick={onClick}>
        {children}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title ?? 'View the recorded document on the county portal'}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

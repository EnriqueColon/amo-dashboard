// A firm's round avatar: its logo when we have one (server/entity-logos.ts), otherwise
// its initials. Logos exist for firms on Targets whose website we know (FDIC for banks,
// or typed on the firm card) and for any firm with a hand-typed website.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';

export const LOGOS_KEY = ['/api/entity-logos'];

export function useEntityLogos(): Record<string, string> {
  const { data } = useQuery({
    queryKey: LOGOS_KEY,
    queryFn: () => apiRequest('GET', '/api/entity-logos').then(r => r.json()),
    staleTime: 10 * 60 * 1000,
    // Logos still being fetched on the server show up on a later poll.
    refetchInterval: (q: any) => ((q.state.data?.pending ?? 0) > 0 ? 20_000 : false),
  });
  return (data?.logos as Record<string, string>) || {};
}

export function initials(name: string): string {
  const words = (name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase();
}

/** `size` is a Tailwind size class pair, e.g. "w-10 h-10"; `fallbackClass` colours the initials. */
export default function EntityAvatar({ name, size = 'w-10 h-10', textSize = 'text-xs', fallbackClass = 'bg-muted text-muted-foreground', className = '' }: {
  name: string;
  size?: string;
  textSize?: string;
  fallbackClass?: string;
  className?: string;
}) {
  const logos = useEntityLogos();
  const src = logos[String(name || '').toUpperCase()];
  const [broken, setBroken] = useState<string | null>(null);
  if (src && broken !== src) {
    return (
      <span className={`${size} rounded-full shrink-0 overflow-hidden bg-white border border-border flex items-center justify-center ${className}`}>
        <img src={src} alt="" loading="lazy" className="w-[78%] h-[78%] object-contain" onError={() => setBroken(src)} />
      </span>
    );
  }
  return (
    <span className={`${size} rounded-full shrink-0 flex items-center justify-center font-semibold ${textSize} ${fallbackClass} ${className}`}>
      {initials(name)}
    </span>
  );
}

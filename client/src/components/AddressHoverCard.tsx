import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { ExternalLink, MapPin } from 'lucide-react';

/** Same rule as server/streetview.ts: only a street address with a house number gets a photo. */
const hasHouseNumber = (a: string) => /^\d+[A-Za-z]?\b/.test(a.replace(/\s+/g, ' ').trim());

function StreetViewPhoto({ address }: { address: string }) {
  const [state, setState] = useState<'loading' | 'ok' | 'none'>('loading');
  if (state === 'none') {
    return <div className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground">No Street View photo for this address</div>;
  }
  return (
    <div className="relative h-[180px] w-full overflow-hidden rounded bg-muted">
      {state === 'loading' && <div className="absolute inset-0 animate-pulse bg-muted" />}
      <img
        src={`/api/streetview?address=${encodeURIComponent(address)}`}
        alt={`Street View of ${address}`}
        className="h-full w-full object-cover"
        onLoad={() => setState('ok')}
        onError={() => setState('none')}
      />
    </div>
  );
}

/** Wraps an address; hovering shows a Street View photo (when the server has a Google key) and a Google Maps link. */
export function AddressHoverCard({ address, children }: { address: string; children: ReactNode }) {
  const { data } = useQuery<{ enabled: boolean }>({ queryKey: ['/api/streetview/status'], staleTime: Infinity });
  const clean = address.replace(/\s+/g, ' ').trim();
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}`;
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div className="cursor-default underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">{children}</div>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-[340px] space-y-2 p-3">
        {data?.enabled && hasHouseNumber(clean) && <StreetViewPhoto address={clean} />}
        <div className="flex items-start gap-1.5 text-sm"><MapPin size={14} className="mt-0.5 shrink-0 text-muted-foreground" />{clean}</div>
        <a href={maps} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Open in Google Maps <ExternalLink size={12} />
        </a>
      </HoverCardContent>
    </HoverCard>
  );
}

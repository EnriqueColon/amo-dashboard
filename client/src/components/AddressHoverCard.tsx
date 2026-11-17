import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { ExternalLink, MapPin } from 'lucide-react';

/** Same rule as server/streetview.ts: only a street address with a house number gets a photo. */
const hasHouseNumber = (a: string) => /^\d+[A-Za-z]?\b/.test(a.replace(/\s+/g, ' ').trim());

type Img = 'loading' | 'ok' | 'none';

/** Seconds each view is held before fading to the other. */
const HOLD_MS = 5000;

/**
 * The Street View photo and a Google map of the address (both from our server, cached per address).
 * When both load, the card holds the photo for 5 s, fades to the map for 5 s, and repeats while it is open.
 * When only one loads, that one stays; when neither does, a one-line note.
 */
function PhotoAndMap({ address }: { address: string }) {
  const [photo, setPhoto] = useState<Img>('loading');
  const [map, setMap] = useState<Img>('loading');
  const [showMap, setShowMap] = useState(false);
  const cycling = photo === 'ok' && map === 'ok';

  useEffect(() => {
    if (!cycling) return;
    const t = setInterval(() => setShowMap(v => !v), HOLD_MS);
    return () => clearInterval(t);
  }, [cycling]);

  if (photo === 'none' && map === 'none') {
    return <div className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground">No Street View photo or map for this address</div>;
  }
  // Which layer is on top: the map when it is the only image, or its turn in the cycle.
  const mapOnTop = map === 'ok' && (photo === 'none' || (cycling && showMap));
  const q = encodeURIComponent(address);
  return (
    <div className="relative h-[235px] w-full overflow-hidden rounded bg-muted">
      {photo === 'loading' && map !== 'ok' && <div className="absolute inset-0 animate-pulse bg-muted" />}
      {photo !== 'none' && (
        <img
          src={`/api/streetview?address=${q}`}
          alt={`Street View of ${address}`}
          className="absolute inset-0 h-full w-full object-cover"
          onLoad={() => setPhoto('ok')}
          onError={() => setPhoto('none')}
        />
      )}
      {map !== 'none' && (
        <img
          src={`/api/staticmap?address=${q}`}
          alt={`Map of ${address}`}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-in-out ${mapOnTop ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setMap('ok')}
          onError={() => setMap('none')}
        />
      )}
      {(photo === 'ok' || map === 'ok') && (
        <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-slate-900/70 px-2 py-0.5 text-[11px] text-white">
          {mapOnTop ? 'Map' : 'Street View'}
        </span>
      )}
      {cycling && (
        <span className="pointer-events-none absolute right-2 top-2.5 flex gap-1" aria-hidden="true">
          <i className={`h-1.5 w-1.5 rounded-full ring-1 ring-black/25 ${mapOnTop ? 'bg-white/55' : 'bg-white'}`} />
          <i className={`h-1.5 w-1.5 rounded-full ring-1 ring-black/25 ${mapOnTop ? 'bg-white' : 'bg-white/55'}`} />
        </span>
      )}
    </div>
  );
}

/** Wraps an address; hovering shows a Street View photo that fades to a map and back (when the server has a Google key), and a Google Maps link. */
export function AddressHoverCard({ address, children }: { address: string; children: ReactNode }) {
  const { data } = useQuery<{ enabled: boolean }>({ queryKey: ['/api/streetview/status'], staleTime: Infinity });
  const clean = address.replace(/\s+/g, ' ').trim();
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}`;
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div className="cursor-default underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">{children}</div>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-[400px] space-y-2 p-3">
        {!data?.enabled
          ? <div className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground">Street View photo not set up yet</div>
          : hasHouseNumber(clean)
            ? <PhotoAndMap address={clean} />
            : <div className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground">No house number, so no Street View photo</div>}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-1.5 text-sm"><MapPin size={14} className="mt-0.5 shrink-0 text-muted-foreground" />{clean}</div>
          <a href={maps} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline">
            Map <ExternalLink size={11} />
          </a>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

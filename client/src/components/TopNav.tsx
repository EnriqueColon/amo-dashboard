import { Link, useLocation } from 'wouter';
import {
  BarChart2, FileText, CheckCircle, Shield, Building2, ClipboardList, LayoutList, LogOut, Crosshair,
  Landmark, FileSignature, MessageSquare, Gauge, Users, Newspaper, Scale, BookOpen, Gavel, ChevronDown, Menu, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCounty, COUNTY_OPTIONS, type CountyScope } from '@/lib/county';
import { FilterHint } from '@/components/FilterHint';
import { COUNTY_DEF } from '@/lib/filterDefinitions';

// Main navigation: four menus along the top; hovering (or focusing / tapping) a menu opens a dropdown
// listing its pages. Replaces the left sidebar (owner's request, 2 Nov 2026: "think the real deal website").
// Group membership and badges are carried over unchanged from the sidebar.
type Item = { href: string; icon: any; label: string; badge?: string };
type Menu = { key: string; label: string; items: Item[] };

const MENUS: Menu[] = [
  {
    key: 'home', label: 'Home', items: [
      // Target Reporting is the landing page: "/" and the logo go here (owner, 4 Nov 2026; was Ask the Data).
      // The route stays /reporting so existing links (e.g. /reporting?targets=1) keep working.
      { href: '/reporting', icon: LayoutList, label: 'Target Reporting', badge: 'Open testing' },
      // "Beta" badge at the owner's request (7 Oct 2026) while the chat is trialled in production.
      { href: '/ask', icon: MessageSquare, label: 'Ask the Data', badge: 'Beta' },
    ],
  },
  {
    key: 'analysis', label: 'Analysis', items: [
      // Overview moved here from Home (owner, 4 Nov 2026).
      { href: '/overview', icon: BarChart2, label: 'Overview' },
      { href: '/targets', icon: Crosshair, label: 'Targets' },
      { href: '/bank-stress', icon: Gauge, label: 'Bank Stress & FDIC', badge: 'New' },
      { href: '/private-credit', icon: Shield, label: 'Private Credit' },
      { href: '/credit-facilities', icon: Landmark, label: 'Lending Relationships' },
    ],
  },
  {
    key: 'intel', label: 'Intelligence', items: [
      // The Market Intelligence tool's tabs, rebuilt here (docs/MARKET_INTEL_MERGE_SESSION.md).
      { href: '/news', icon: Newspaper, label: 'News', badge: 'New' },
      { href: '/legal', icon: Scale, label: 'Legal Landscape', badge: 'New' },
      { href: '/research', icon: BookOpen, label: 'Market Research', badge: 'New' },
      { href: '/peers', icon: Users, label: 'Peers', badge: 'New' },
    ],
  },
  {
    key: 'data', label: 'Data', items: [
      { href: '/assignments', icon: FileText, label: 'Raw Assignments' },
      // UCC Filings and Clean Transactions are document views, not analyses (owner, 29 Oct 2026).
      { href: '/complaints', icon: Gavel, label: 'Complaints', badge: 'Open testing' },
      { href: '/ucc', icon: FileSignature, label: 'UCC Filings' },
      { href: '/clean-events', icon: CheckCircle, label: 'Clean Transactions' },
      { href: '/entities', icon: Building2, label: 'Entities' },
      { href: '/collection-log', icon: ClipboardList, label: 'Collection Log' },
    ],
  },
];

const isActive = (location: string, href: string) => location === href || location.startsWith(href + '/');

function Badge({ children }: { children: string }) {
  return <span className="text-[9px] font-bold bg-primary/20 text-primary px-1.5 py-0.5 rounded-full shrink-0">{children}</span>;
}

function DesktopMenu({ menu, location, open, setOpen }: {
  menu: Menu; location: string; open: string | null; setOpen: (k: string | null) => void;
}) {
  const closeTimer = useRef<number | undefined>(undefined);
  const isOpen = open === menu.key;
  const active = menu.items.some(i => isActive(location, i.href));
  const show = () => { window.clearTimeout(closeTimer.current); setOpen(menu.key); };
  // A short delay so the pointer can cross the gap between the label and the panel without it closing.
  const hide = () => { closeTimer.current = window.setTimeout(() => setOpen(null), 140); };

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(null); }}>
      <button
        type="button" aria-haspopup="menu" aria-expanded={isOpen}
        data-testid={`menu-${menu.key}`}
        onClick={() => (isOpen ? setOpen(null) : show())}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(null); }}
        className={`flex items-center gap-1 px-3 h-12 text-[13px] font-medium tracking-wide border-b-2 transition-colors
          ${active || isOpen ? 'text-foreground border-primary' : 'text-muted-foreground border-transparent hover:text-foreground'}`}
      >
        {menu.label}
        <ChevronDown size={12} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div role="menu" className="absolute left-0 top-full z-50 w-64 rounded-b-md border border-border bg-card shadow-xl py-1.5">
          {menu.items.map(({ href, icon: Icon, label, badge }) => (
            <Link key={href} href={href} role="menuitem"
              data-testid={`nav-${label.toLowerCase().replace(/\s+/g, '-')}`}
              onClick={() => setOpen(null)}
              className={`flex items-center gap-2.5 px-3.5 py-2 text-sm transition-colors cursor-pointer
                ${isActive(location, href) ? 'bg-primary/10 text-primary font-medium' : 'text-foreground/80 hover:bg-muted hover:text-foreground'}`}>
              <Icon size={15} className="shrink-0" />
              <span className="flex-1 text-[13px] leading-tight">{label}</span>
              {badge && <Badge>{badge}</Badge>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TopNav() {
  const [location] = useLocation();
  const { county, setCounty } = useCounty();
  const [open, setOpen] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setOpen(null); setMobileOpen(false); }, [location]);

  const countySelect = (
    <FilterHint def={COUNTY_DEF}>
      <select
        id="county-scope" data-testid="county-scope" aria-label="County" value={county}
        onChange={e => setCounty(e.target.value as CountyScope)}
        className="text-xs rounded border border-border bg-background px-2 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {COUNTY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </FilterHint>
  );

  return (
    <header data-testid="topnav" className="relative z-40 shrink-0 bg-card border-b border-border print:hidden">
      <div className="flex items-center gap-4 px-4 h-12">
        <button type="button" className="md:hidden p-1 rounded hover:bg-muted text-muted-foreground"
          aria-label="Menu" onClick={() => setMobileOpen(o => !o)}>
          {mobileOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        <Link href="/reporting" className="flex items-center gap-2 min-w-0 shrink-0">
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-label="SHCP Intelligence Platform">
            <rect x="2" y="2" width="28" height="28" rx="4" fill="hsl(38 95% 55% / 0.15)" stroke="hsl(38 95% 55%)" strokeWidth="1.5" />
            <path d="M7 24 L12 10 L16 19 L20 14 L25 24" stroke="hsl(38 95% 55%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx="16" cy="19" r="2" fill="hsl(38 95% 55%)" />
          </svg>
          <div className="min-w-0 leading-tight">
            <div className="font-semibold text-sm text-foreground truncate">SHCP Intelligence</div>
            <div className="hidden lg:block text-[9px] text-muted-foreground truncate">Platform · Safe Harbor Capital Partners</div>
          </div>
        </Link>

        <nav className="hidden md:flex items-stretch ml-2" aria-label="Main">
          {MENUS.map(m => <DesktopMenu key={m.key} menu={m} location={location} open={open} setOpen={setOpen} />)}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden sm:block">{countySelect}</div>
          <form method="POST" action="/logout">
            <button type="submit" title="Sign out"
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <LogOut size={14} className="shrink-0" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </form>
        </div>
      </div>

      {/* Phone / narrow window: the same four menus as an expanding list */}
      {mobileOpen && (
        <nav className="md:hidden border-t border-border bg-card max-h-[75vh] overflow-y-auto px-3 py-2" aria-label="Main">
          <div className="sm:hidden pb-2">{countySelect}</div>
          {MENUS.map(m => (
            <div key={m.key} className="pb-1">
              <div className="px-2 pt-2 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{m.label}</div>
              {m.items.map(({ href, icon: Icon, label, badge }) => (
                <Link key={href} href={href}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm ${isActive(location, href) ? 'bg-primary/15 text-primary font-medium' : 'text-foreground/80 hover:bg-muted'}`}>
                  <Icon size={15} className="shrink-0" />
                  <span className="flex-1 text-[13px]">{label}</span>
                  {badge && <Badge>{badge}</Badge>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      )}
    </header>
  );
}

import { Link, useLocation } from 'wouter';
import { BarChart2, FileText, CheckCircle, Share2, Shield, Building2, ClipboardList, Menu, X, LineChart } from 'lucide-react';
import { useState } from 'react';

const NAV = [
  { href: '/',                    icon: BarChart2,     label: 'Overview',             group: 'main' },
  { href: '/market-relationships',icon: Share2,        label: 'Market Relationships', group: 'analysis', badge: 'NEW' },
  { href: '/market-analytics',    icon: LineChart,     label: 'Market Analytics',     group: 'analysis' },
  { href: '/clean-events',        icon: CheckCircle,   label: 'Clean Transactions',   group: 'analysis' },
  { href: '/private-credit',      icon: Shield,        label: 'Private Credit',       group: 'analysis' },
  { href: '/assignments',         icon: FileText,       label: 'Raw Assignments',      group: 'data' },
  { href: '/entities',            icon: Building2,      label: 'Entities',             group: 'data' },
  { href: '/collection-log',      icon: ClipboardList,  label: 'Collection Log',       group: 'data' },
];

const GROUPS: Record<string, string> = {
  main: '',
  analysis: 'Analysis',
  data: 'Data',
};

export default function Sidebar() {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  let lastGroup = '';

  return (
    <aside
      data-testid="sidebar"
      className={`flex flex-col bg-card border-r border-border transition-all duration-200 ${collapsed ? 'w-14' : 'w-60'} shrink-0`}
    >
      {/* Logo + toggle */}
      <div className="flex items-center gap-3 px-3 py-4 border-b border-border">
        <button
          data-testid="sidebar-toggle"
          onClick={() => setCollapsed(c => !c)}
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shrink-0"
        >
          {collapsed ? <Menu size={18} /> : <X size={18} />}
        </button>
        {!collapsed && (
          <div className="flex items-center gap-2 min-w-0">
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-label="AMO Tracker">
              <rect x="2" y="2" width="28" height="28" rx="4" fill="hsl(38 95% 55% / 0.15)" stroke="hsl(38 95% 55%)" strokeWidth="1.5"/>
              <path d="M7 24 L12 10 L16 19 L20 14 L25 24" stroke="hsl(38 95% 55%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              <circle cx="16" cy="19" r="2" fill="hsl(38 95% 55%)"/>
            </svg>
            <div className="min-w-0">
              <div className="font-semibold text-sm text-foreground truncate">AMO Tracker</div>
              <div className="text-[9px] text-muted-foreground truncate">Miami-Dade County</div>
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2 px-1.5 overflow-y-auto">
        {NAV.map(({ href, icon: Icon, label, group, badge }) => {
          const active = location === href || (href !== '/' && location.startsWith(href));
          const showGroupLabel = !collapsed && group !== lastGroup && GROUPS[group];
          if (group !== lastGroup) lastGroup = group;

          return (
            <div key={href}>
              {showGroupLabel && (
                <div className="px-2 pt-3 pb-1">
                  <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">
                    {GROUPS[group]}
                  </span>
                </div>
              )}
              <Link href={href}>
                <a
                  data-testid={`nav-${label.toLowerCase().replace(/\s+/g, '-')}`}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors cursor-pointer mb-0.5
                    ${active
                      ? 'bg-primary/15 text-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                >
                  <Icon size={15} className="shrink-0" />
                  {!collapsed && (
                    <span className="truncate flex-1 text-xs">{label}</span>
                  )}
                  {!collapsed && badge && (
                    <span className="text-[9px] font-bold bg-primary/20 text-primary px-1.5 py-0.5 rounded-full shrink-0">
                      {badge}
                    </span>
                  )}
                </a>
              </Link>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      {!collapsed && (
        <div className="px-3 py-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground">Official Records · AMO</p>
          <p className="text-[10px] text-muted-foreground/60">Auto-collects Fridays 4pm EDT</p>
        </div>
      )}
    </aside>
  );
}

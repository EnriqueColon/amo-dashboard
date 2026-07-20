import { Switch, Route, Router } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import Sidebar from '@/components/Sidebar';
import Dashboard from '@/pages/Dashboard';
import Assignments from '@/pages/Assignments';
import CleanEvents from '@/pages/CleanEvents';
import MarketAnalytics from '@/pages/MarketAnalytics';
import PrivateCredit from '@/pages/PrivateCredit';
import CreditFacilities from '@/pages/CreditFacilities';
import Reporting from '@/pages/Reporting';
import Targets from '@/pages/Targets';
import Entities from '@/pages/Entities';
import CollectionLog from '@/pages/CollectionLog';
import NotFound from '@/pages/not-found';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Router hook={useHashLocation}>
          <div className="flex h-screen overflow-hidden bg-background print:h-auto print:overflow-visible">
            <Sidebar />
            <main className="flex-1 overflow-y-auto flex flex-col print:overflow-visible">
              <Switch>
                <Route path="/" component={Dashboard} />
                <Route path="/clean-events" component={CleanEvents} />
                <Route path="/market-analytics" component={MarketAnalytics} />
                <Route path="/assignments" component={Assignments} />
                <Route path="/private-credit" component={PrivateCredit} />
                <Route path="/credit-facilities" component={CreditFacilities} />
                <Route path="/reporting" component={Reporting} />
                <Route path="/targets" component={Targets} />
                <Route path="/entities" component={Entities} />
                <Route path="/collection-log" component={CollectionLog} />
                <Route component={NotFound} />
              </Switch>
            </main>
          </div>
        </Router>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

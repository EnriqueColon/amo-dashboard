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
import MarketRelationships from '@/pages/MarketRelationships';
import MarketAnalytics from '@/pages/MarketAnalytics';
import PrivateCredit from '@/pages/PrivateCredit';
import DealIntelligence from '@/pages/DealIntelligence';
import Entities from '@/pages/Entities';
import CollectionLog from '@/pages/CollectionLog';
import NotFound from '@/pages/not-found';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Router hook={useHashLocation}>
          <div className="flex h-screen overflow-hidden bg-background">
            <Sidebar />
            <main className="flex-1 overflow-y-auto flex flex-col">
              <Switch>
                <Route path="/" component={Dashboard} />
                <Route path="/clean-events" component={CleanEvents} />
                <Route path="/market-relationships" component={MarketRelationships} />
                <Route path="/market-analytics" component={MarketAnalytics} />
                <Route path="/assignments" component={Assignments} />
                <Route path="/private-credit" component={PrivateCredit} />
                <Route path="/deal-intelligence" component={DealIntelligence} />
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

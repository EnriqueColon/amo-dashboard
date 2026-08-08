import { createContext, useContext, useState, type ReactNode } from 'react';
import { queryClient } from './queryClient';
import {
  DEFAULT_COUNTY, getCurrentCounty, persistCounty, setCurrentCounty,
  type CountyScope,
} from './county-scope';

export {
  COUNTY_OPTIONS, countyLabel, type CountyScope,
} from './county-scope';

/**
 * Global county scope.
 *
 * The server defaults to Miami-Dade when no `county` parameter is sent
 * (server/routes.ts DEFAULT_SCOPE), but the client always sends one explicitly
 * so the scope shown in the UI and the scope applied by the server cannot drift.
 */
const CountyContext = createContext<{
  county: CountyScope;
  setCounty: (c: CountyScope) => void;
}>({ county: DEFAULT_COUNTY, setCounty: () => {} });

export function CountyProvider({ children }: { children: ReactNode }) {
  const [county, setCountyState] = useState<CountyScope>(getCurrentCounty());

  const setCounty = (next: CountyScope) => {
    if (next === county) return;
    setCurrentCounty(next);   // before clearing, so the refetches use the new scope
    setCountyState(next);
    persistCounty(next);

    // The county is NOT part of any queryKey — it rides on the URL inside the
    // fetch layer — so two scopes would otherwise share one cache entry and the
    // UI would show the previous county's numbers under the new label. Clearing
    // is blunt but certain; invalidateQueries() would leave unmounted pages
    // holding stale rows that reappear on navigation.
    queryClient.clear();
  };

  return (
    <CountyContext.Provider value={{ county, setCounty }}>
      {children}
    </CountyContext.Provider>
  );
}

export function useCounty() {
  return useContext(CountyContext);
}

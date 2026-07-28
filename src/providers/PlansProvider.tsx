import { use, useCallback, useEffect, useState } from 'react';

import { Booking } from '@/api/itinerary';
import ClientsContext from '@/contexts/ClientsContext';
import PlansContext from '@/contexts/PlansContext';
import useDataLoader from '@/hooks/useDataLoader';
import useThrottleable from '@/hooks/useThrottleable';

export default function PlansProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { itinerary } = use(ClientsContext);
  const { loadData, loaderElem } = useDataLoader();
  const [plans, setPlans] = useState<Booking[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);

  const refreshPlans = useThrottleable(
    useCallback(() => {
      loadData(async () => {
        setPlans(await itinerary.plans());
        setPlansLoaded(true);
      });
    }, [itinerary, loadData])
  );

  useEffect(refreshPlans, [refreshPlans]);

  // Periodically refresh plans so the auto-booker detects freed LL slots promptly
  useEffect(() => {
    const id = setInterval(() => refreshPlans(), 30_000);
    return () => clearInterval(id);
  }, [refreshPlans]);

  return (
    <PlansContext value={{ plans, plansLoaded, refreshPlans, loaderElem }}>
      {children}
    </PlansContext>
  );
}

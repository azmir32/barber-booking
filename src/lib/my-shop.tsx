import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { appCache } from '@/lib/app-cache';
import { useAuth } from '@/lib/auth';
import { cacheKey } from '@/lib/cache';
import { supabase } from '@/lib/supabase';
import type { Shop } from '@/lib/types';

type MyShopState = {
  shop: Shop | null;
  loading: boolean;
  /** False while the shop shown is the one kept from last time, until the server answers. */
  fresh: boolean;
  reload: () => Promise<void>;
};

const MyShopContext = createContext<MyShopState | null>(null);

/**
 * Loads the signed-in barber's own shop for the barber screens: the one kept
 * from last time at once, then the server's. Mount one per account.
 */
export function MyShopProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const key = userId ? cacheKey(userId, 'my-shop') : null;
  const [kept] = useState(() => (key ? appCache.peek<Shop>(key) : null));
  const [shop, setShop] = useState<Shop | null>(kept?.data ?? null);
  const [loading, setLoading] = useState(!kept);
  const [fresh, setFresh] = useState(false);

  const reload = useCallback(async () => {
    const { shop: s, error } = await fetchShop(userId);
    // Without a connection the shop on screen stays, rather than the set-up form.
    if (error) return;
    setShop(s);
    setFresh(true);
  }, [userId]);

  useEffect(() => {
    let active = true;
    fetchShop(userId).then(({ shop: s, error }) => {
      if (!active) return;
      if (!error) {
        setShop(s);
        setFresh(true);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  return <MyShopContext.Provider value={{ shop, loading, fresh, reload }}>{children}</MyShopContext.Provider>;
}

async function fetchShop(userId: string | undefined): Promise<{ shop: Shop | null; error: unknown }> {
  if (!userId) return { shop: null, error: null };
  const { data, error } = await supabase.from('shops').select('*').eq('owner_id', userId).maybeSingle();
  if (data) appCache.write(cacheKey(userId, 'my-shop'), data);
  return { shop: data as Shop | null, error };
}

export function useMyShop(): MyShopState {
  const ctx = useContext(MyShopContext);
  if (!ctx) throw new Error('useMyShop must be used inside MyShopProvider');
  return ctx;
}

/** Hours every new barber starts with: 10am to 8pm, Monday to Saturday. */
export function defaultHours(barberId: string) {
  return [1, 2, 3, 4, 5, 6].map((weekday) => ({
    barber_id: barberId,
    weekday,
    opens_at: '10:00',
    closes_at: '20:00',
  }));
}

export async function addBarber(shopId: string, name: string, sortOrder = 0) {
  const { data, error } = await supabase
    .from('barbers')
    .insert({ shop_id: shopId, name: name.trim(), sort_order: sortOrder })
    .select()
    .single();
  if (error) return { error };
  const hours = await supabase.from('working_hours').insert(defaultHours(data.id));
  return { error: hours.error, barber: data };
}

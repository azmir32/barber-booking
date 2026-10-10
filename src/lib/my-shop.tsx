import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Shop } from '@/lib/types';

type MyShopState = {
  shop: Shop | null;
  loading: boolean;
  reload: () => Promise<void>;
};

const MyShopContext = createContext<MyShopState | null>(null);

/** Loads the signed-in barber's own shop for the barber screens. */
export function MyShopProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [shop, setShop] = useState<Shop | null>(null);
  const [loading, setLoading] = useState(true);
  const userId = session?.user.id;

  const reload = useCallback(async () => {
    setShop(await fetchShop(userId));
  }, [userId]);

  useEffect(() => {
    let active = true;
    fetchShop(userId).then((s) => {
      if (!active) return;
      setShop(s);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  return <MyShopContext.Provider value={{ shop, loading, reload }}>{children}</MyShopContext.Provider>;
}

async function fetchShop(userId: string | undefined): Promise<Shop | null> {
  if (!userId) return null;
  const { data } = await supabase.from('shops').select('*').eq('owner_id', userId).maybeSingle();
  return data as Shop | null;
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

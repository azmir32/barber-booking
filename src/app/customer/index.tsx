import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Empty, ErrorText, Field, Row, T } from '@/components/ui';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatPrice } from '@/lib/time';
import type { Shop } from '@/lib/types';

type ShopListing = Pick<Shop, 'id' | 'name' | 'slug' | 'area' | 'address' | 'about'> & {
  services: { price: number; is_active: boolean }[];
  barbers: { id: string; is_active: boolean }[];
};

export default function Explore() {
  const theme = useTheme();
  const [shops, setShops] = useState<ShopListing[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // RLS only returns shops that are published and paid up or in trial.
    const { data, error } = await supabase
      .from('shops')
      .select('id, name, slug, area, address, about, services(price, is_active), barbers(id, is_active)')
      .order('name');
    setLoading(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    setShops((data ?? []) as ShopListing[]);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return shops.filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.area.toLowerCase().includes(q) ||
        (s.address ?? '').toLowerCase().includes(q),
    );
  }, [shops, query]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView
        contentContainerStyle={{
          padding: Spacing.lg,
          gap: Spacing.lg,
          width: '100%',
          maxWidth: MaxContentWidth,
          alignSelf: 'center',
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
        <T variant="title">Find a barber</T>
        <Field label="Search" value={query} onChangeText={setQuery} placeholder="Shop name or area, e.g. Sungai Chua" />
        <ErrorText message={error} />
        {!loading && visible.length === 0 ? (
          <Empty
            title={query ? 'No matches' : 'No barbers yet'}
            body={query ? 'Try another name or area.' : 'Barbers in your area are joining soon. Check back shortly.'}
          />
        ) : null}
        {visible.map((shop) => {
          const prices = shop.services.filter((s) => s.is_active).map((s) => Number(s.price));
          const chairs = shop.barbers.filter((b) => b.is_active).length;
          return (
            <Card key={shop.id} onPress={() => router.push(`/shop/${shop.slug}`)}>
              <T variant="heading">{shop.name}</T>
              <T variant="muted">{shop.address || shop.area}</T>
              {shop.about ? (
                <T numberOfLines={2} variant="small">
                  {shop.about}
                </T>
              ) : null}
              <Row>
                {prices.length ? <T variant="label">From {formatPrice(Math.min(...prices))}</T> : null}
                {chairs ? (
                  <T variant="small">
                    {chairs} {chairs === 1 ? 'barber' : 'barbers'}
                  </T>
                ) : null}
              </Row>
            </Card>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

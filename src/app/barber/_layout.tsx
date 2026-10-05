import { Redirect, Stack } from 'expo-router';

import { ShopForm } from '@/components/shop-form';
import { Loading, Screen, T } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { MyShopProvider, useMyShop } from '@/lib/my-shop';

export default function BarberLayout() {
  const { session, profile, loading } = useAuth();
  if (loading || (session && !profile)) return <Loading />;
  if (!session) return <Redirect href="/welcome" />;
  if (profile?.role !== 'barber') return <Redirect href="/customer" />;
  return (
    <MyShopProvider>
      <BarberStack />
    </MyShopProvider>
  );
}

function BarberStack() {
  const { shop, loading, reload } = useMyShop();

  if (loading) return <Loading />;
  if (!shop) {
    return (
      <Screen>
        <T variant="title">Set up your shop</T>
        <T variant="muted">This is what customers see. You can change any of it later.</T>
        <ShopForm onSaved={reload} />
      </Screen>
    );
  }

  return (
    <Stack screenOptions={{ headerBackTitle: 'Back' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="hours/[id]" options={{ title: 'Working hours' }} />
    </Stack>
  );
}

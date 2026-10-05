import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';

import { ShopForm } from '@/components/shop-form';
import { Loading, Screen, T } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { MyShopProvider, useMyShop } from '@/lib/my-shop';

export default function BarberLayout() {
  const { session, profile, loading } = useAuth();
  if (loading || (session && !profile)) return <Loading />;
  if (!session) return <Redirect href="/welcome" />;
  if (profile?.role !== 'barber') return <Redirect href="/customer" />;
  return (
    <MyShopProvider>
      <BarberTabs />
    </MyShopProvider>
  );
}

function BarberTabs() {
  const theme = useTheme();
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
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: { backgroundColor: theme.card, borderTopColor: theme.border },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Bookings',
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="services"
        options={{
          title: 'Services',
          tabBarIcon: ({ color, size }) => <Ionicons name="pricetags-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: 'Barbers',
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="shop"
        options={{
          title: 'My shop',
          tabBarIcon: ({ color, size }) => <Ionicons name="storefront-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen name="hours/[id]" options={{ href: null }} />
    </Tabs>
  );
}

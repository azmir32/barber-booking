import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';

import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { badgeText, changesLabel } from '@/lib/news';
import { ShopNewsProvider, useShopNews } from '@/lib/shop-news';

export default function BarberTabs() {
  const { shop } = useMyShop();
  return (
    <ShopNewsProvider shopId={shop?.id ?? null}>
      <TabBar />
    </ShopNewsProvider>
  );
}

function TabBar() {
  const theme = useTheme();
  const { news } = useShopNews();
  const count = news?.count ?? 0;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.tint,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: { backgroundColor: theme.card, borderTopColor: theme.border },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t('Bookings'),
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar-outline" color={color} size={size} />,
          // What customers booked, moved or cancelled since this phone last looked.
          tabBarBadge: badgeText(count),
          tabBarBadgeStyle: { backgroundColor: theme.accent, color: theme.accentText },
          // The badge alone reads as a bare number, so the tab's name says what it counts.
          tabBarAccessibilityLabel: count > 0 ? `${t('Bookings')}, ${changesLabel(count)}` : undefined,
        }}
      />
      <Tabs.Screen
        name="services"
        options={{
          title: t('Services'),
          tabBarIcon: ({ color, size }) => <Ionicons name="pricetags-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: t('Barbers'),
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="shop"
        options={{
          title: t('My shop'),
          tabBarIcon: ({ color, size }) => <Ionicons name="storefront-outline" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}

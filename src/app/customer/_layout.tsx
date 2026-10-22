import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';

import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { useTabBarText } from '@/lib/text-size-provider';

export default function CustomerTabs() {
  const theme = useTheme();
  const { tabBarLabelStyle, barHeight } = useTabBarText();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.tint,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: { backgroundColor: theme.card, borderTopColor: theme.border, ...barHeight },
        tabBarLabelStyle,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t('Barbers'),
          tabBarIcon: ({ color, size }) => <Ionicons aria-hidden name="cut-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="bookings"
        options={{
          title: t('My bookings'),
          tabBarIcon: ({ color, size }) => <Ionicons aria-hidden name="calendar-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: t('Account'),
          tabBarIcon: ({ color, size }) => <Ionicons aria-hidden name="person-outline" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}

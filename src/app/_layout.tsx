import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { Empty, Screen, T } from '@/components/ui';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { AuthProvider } from '@/lib/auth';
import { isSupabaseConfigured } from '@/lib/supabase';

export default function RootLayout() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: Colors[scheme].accent,
      background: Colors[scheme].background,
      card: Colors[scheme].card,
      text: Colors[scheme].text,
      border: Colors[scheme].border,
    },
  };

  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style="auto" />
      {isSupabaseConfigured ? (
        <AuthProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="shop/[slug]" options={{ headerShown: true, title: '', headerBackTitle: 'Back' }} />
            <Stack.Screen name="sign-in" options={{ headerShown: true, title: 'Sign in', headerBackTitle: 'Back' }} />
            <Stack.Screen name="sign-up" options={{ headerShown: true, title: 'Create account', headerBackTitle: 'Back' }} />
          </Stack>
        </AuthProvider>
      ) : (
        <Screen>
          <Empty
            title="Almost there"
            body="Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to a .env file, then restart the app. See the README for the steps."
          />
          <T variant="small" style={{ textAlign: 'center' }}>
            Copy .env.example to .env to get started.
          </T>
        </Screen>
      )}
    </ThemeProvider>
  );
}

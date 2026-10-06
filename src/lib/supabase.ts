import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { t } from '@/lib/lang';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * The demo build (EXPO_PUBLIC_DEMO=1, see scripts/build-demo.mjs) answers
 * every request from a pretend backend inside the page, with sample shops.
 * Other builds leave it out entirely.
 */
export const demo: typeof import('@/demo/server') | null =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  process.env.EXPO_PUBLIC_DEMO === '1' ? require('@/demo/server') : null;

export const isSupabaseConfigured = Boolean(demo || (url && anonKey));

export const supabase = createClient(
  demo?.DEMO_URL ?? (url || 'http://localhost:54321'),
  demo?.DEMO_ANON_KEY ?? (anonKey || 'not-configured'),
  {
    auth: {
      storage: demo?.demoStorage ?? AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: demo ? { fetch: demo.demoFetch } : {},
  },
);

// Only refresh the session while the app is in the foreground.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

/**
 * Turns a Supabase/Postgres error into a sentence a person can read, in
 * their language. The booking functions' messages are in strings-ms.ts.
 */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    if ('code' in error && error.code === '23505') return t('That name or link is already taken.');
    if ('code' in error && error.code === '23514') {
      return t('Something there is too long or not allowed. Please check and try again.');
    }
    const limit = /^You already have (\d+) upcoming bookings here\./.exec(error.message);
    if (limit) {
      return t('You already have {count} upcoming bookings here. Cancel one to book another.', { count: limit[1] });
    }
    return t(error.message);
  }
  return t('Something went wrong. Please try again.');
}

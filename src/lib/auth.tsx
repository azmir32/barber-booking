import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { appCache } from '@/lib/app-cache';
import { cacheKey, GUEST } from '@/lib/cache';
import { supabase } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

type AuthState = {
  session: Session | null;
  profile: Profile | null;
  /** True until the stored session (and its profile) has been loaded. */
  loading: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null);
      return;
    }
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, full_name, phone')
      .eq('id', s.user.id)
      .maybeSingle();
    // With no connection, the profile kept from last time stays.
    if (error) return setProfile((p) => (p?.id === s.user.id ? p : null));
    setProfile(data as Profile | null);
    if (data) appCache.write(cacheKey(s.user.id, 'profile'), data);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      const uid = data.session?.user.id ?? null;
      appCache.setUser(uid);
      // Last visit's answers, so screens open with them while they ask again.
      await appCache.load(uid ?? GUEST);
      if (!active) return;
      setSession(data.session);
      const kept = uid ? appCache.peek<Profile>(cacheKey(uid, 'profile')) : null;
      if (kept) {
        setProfile(kept.data);
        setLoading(false);
        loadProfile(data.session);
        return;
      }
      await loadProfile(data.session);
      if (active) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // Signed out here, or the session ran out: nothing of theirs stays on the phone.
      if (event === 'SIGNED_OUT') appCache.clear();
      else appCache.setUser(s?.user.id ?? null);
      setSession(s);
      // Someone else signed in: drop the old profile until theirs loads.
      setProfile((p) => (p && p.id === s?.user.id ? p : null));
      // Supabase warns against awaiting other calls inside this callback.
      setTimeout(() => loadProfile(s), 0);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value: AuthState = {
    session,
    profile,
    loading,
    refreshProfile: () => loadProfile(session),
    signOut: async () => {
      // First, so nothing of theirs stays behind even when the sign out can't reach the server.
      await appCache.clear();
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

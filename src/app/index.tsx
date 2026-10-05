import { Redirect } from 'expo-router';

import { Loading } from '@/components/ui';
import { useAuth } from '@/lib/auth';

// Sends people to the right home: welcome page, customer tabs or barber tabs.
export default function Index() {
  const { session, profile, loading } = useAuth();
  if (loading || (session && !profile)) return <Loading />;
  if (!session || !profile) return <Redirect href="/welcome" />;
  return <Redirect href={profile.role === 'barber' ? '/barber' : '/customer'} />;
}

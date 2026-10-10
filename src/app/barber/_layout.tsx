import { Redirect, router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { LanguagePicker } from '@/components/account-panel';
import { ShopForm } from '@/components/shop-form';
import { Button, ErrorText, Loading, Screen, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { MyShopProvider, useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';

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
        <T variant="title">{t('Set up your shop')}</T>
        <T variant="muted">{t('This is what customers see. You can change any of it later.')}</T>
        <ShopForm onSaved={reload} />
        <SetUpWayOut />
      </Screen>
    );
  }

  return (
    <Stack screenOptions={{ headerBackTitle: t('Back') }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="hours/[id]" options={{ title: t('Working hours') }} />
      <Stack.Screen name="new-booking" options={{ title: t('Add to the day') }} />
      <Stack.Screen name="move-booking" options={{ title: t('Change time') }} />
      <Stack.Screen name="close-days" options={{ title: t('Close for a few days') }} />
      <Stack.Screen name="poster" options={{ title: t('Shop poster') }} />
      <Stack.Screen name="summary" options={{ title: t('Takings') }} />
      <Stack.Screen name="customers" options={{ title: t('Customers') }} />
    </Stack>
  );
}

/**
 * Under the set-up form, which is all a barber account without a shop sees:
 * who is signed in, a way out for anyone who picked "Barber / shop owner" by
 * mistake or wants another account, and the language.
 */
function SetUpWayOut() {
  const { session, signOut, refreshProfile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function becomeCustomer() {
    const ok = await confirmAction(
      t('Use the app as a customer?'),
      t('You’ll find barbers and book cuts. To set up a shop later, sign up again with another email.'),
      t('Yes, I’m a customer'),
      t('Keep setting up'),
    );
    if (!ok) return;
    setBusy(true);
    const { error } = await supabase.rpc('become_customer');
    if (error) {
      setBusy(false);
      return setError(errorMessage(error));
    }
    // With the new role the barber screens hand over to the customer ones.
    await refreshProfile();
  }

  return (
    <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
      {session?.user.email ? (
        <T variant="small" style={{ textAlign: 'center' }}>
          {t('Signed in as {email}', { email: session.user.email })}
        </T>
      ) : null}
      <ErrorText message={error} />
      <Button title={t('I’m a customer, not a barber')} variant="ghost" loading={busy} onPress={becomeCustomer} />
      <Button
        title={t('Sign out')}
        variant="ghost"
        onPress={async () => {
          await signOut();
          router.replace('/welcome');
        }}
      />
      <LanguagePicker />
    </View>
  );
}

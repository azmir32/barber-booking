import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ErrorText, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { demo, errorMessage, supabase } from '@/lib/supabase';

type Side = 'customer' | 'barber';

/** Signs in as one of the demo's sample people: Hakim the customer or Ali the barber. */
export async function tryDemoAs(side: Side) {
  if (!demo) return null;
  await supabase.auth.signOut();
  const { error } = await supabase.auth.signInWithPassword({
    email: side === 'barber' ? demo.DEMO_BARBER_EMAIL : demo.DEMO_CUSTOMER_EMAIL,
    password: demo.DEMO_PASSWORD,
  });
  if (!error) router.replace('/');
  return error;
}

/** The demo build's welcome card: one tap into either side of the app. */
export function DemoPanel() {
  const theme = useTheme();
  const [busy, setBusy] = useState<Side | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!demo) return null;

  async function go(side: Side) {
    setBusy(side);
    setError(null);
    const failed = await tryDemoAs(side);
    setBusy(null);
    if (failed) setError(errorMessage(failed));
  }

  async function startAgain() {
    const ok = await confirmAction(
      t('Start the demo again?'),
      t('Every booking, shop and account goes back to the sample data.'),
      t('Start again'),
    );
    if (!ok || !demo) return;
    await supabase.auth.signOut();
    demo.resetDemo();
    setError(null);
  }

  return (
    <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.accent }]}>
      <T variant="label" style={{ color: theme.accent }}>
        {t('Demo')}
      </T>
      <T variant="heading">{t('Try it with sample shops in Kajang')}</T>
      <T variant="muted">
        {t('As a customer you are Hakim. As a barber you are Ali, who runs Ali Barber Sungai Chua.')}
      </T>
      <Button title={t('Try as a customer')} onPress={() => go('customer')} loading={busy === 'customer'} />
      <Button
        title={t('Try as a barber')}
        variant="secondary"
        onPress={() => go('barber')}
        loading={busy === 'barber'}
      />
      <ErrorText message={error} />
      <T variant="small">
        {t('Nothing here is real and nothing is sent anywhere. Your changes stay on this device.')}
      </T>
      <Button title={t('Start the demo again')} variant="ghost" onPress={startAgain} />
    </View>
  );
}

/** In the demo, a quick way across to the other side of the app. */
export function DemoSwitch({ role }: { role: Side }) {
  const [error, setError] = useState<string | null>(null);
  if (!demo) return null;
  const other: Side = role === 'barber' ? 'customer' : 'barber';
  return (
    <>
      <Button
        title={other === 'barber' ? t('See the barber side') : t('See the customer side')}
        variant="secondary"
        onPress={async () => {
          const failed = await tryDemoAs(other);
          if (failed) setError(errorMessage(failed));
        }}
      />
      <ErrorText message={error} />
    </>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 2, borderRadius: 12, padding: Spacing.lg, gap: Spacing.sm },
});

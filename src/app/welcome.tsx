import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Screen, T } from '@/components/ui';
import { APP_NAME } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function Welcome() {
  const theme = useTheme();
  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.hero}>
        <View style={[styles.logo, { backgroundColor: theme.accent }]}>
          <T style={[styles.logoText, { color: theme.accentText }]}>✂</T>
        </View>
        <T variant="title" style={styles.center}>
          {APP_NAME}
        </T>
        <T variant="muted" style={styles.center}>
          Book your next haircut in seconds. No calls, no waiting for DM replies.
        </T>
      </View>

      <View style={styles.actions}>
        <Button title="Find a barber" onPress={() => router.push('/customer')} />
        <Button title="Sign in" variant="secondary" onPress={() => router.push('/sign-in')} />
      </View>

      <View style={[styles.barberBox, { borderColor: theme.border }]}>
        <T variant="heading">Are you a barber?</T>
        <T variant="muted">
          Get your own booking link, fill your chairs and cut down on no-shows. Free for your first month.
        </T>
        <Button
          title="Set up my shop"
          variant="ghost"
          onPress={() => router.push({ pathname: '/sign-up', params: { role: 'barber' } })}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: Spacing.md, paddingTop: Spacing.xxl },
  logo: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  logoText: { fontSize: 36, lineHeight: 42 },
  center: { textAlign: 'center' },
  actions: { gap: Spacing.md },
  barberBox: { borderWidth: 1, borderRadius: 12, padding: Spacing.lg, gap: Spacing.sm },
});

import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { DemoPanel } from '@/components/demo-panel';
import { Button, Screen, T } from '@/components/ui';
import { APP_NAME } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useLanguage } from '@/lib/i18n';
import { t } from '@/lib/lang';

export default function Welcome() {
  const theme = useTheme();
  const { lang, setLang } = useLanguage();
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
          {t('Book your next haircut in seconds. No calls, no waiting for DM replies.')}
        </T>
      </View>

      <DemoPanel />

      <View style={styles.actions}>
        <Button title={t('Find a barber')} onPress={() => router.push('/customer')} />
        <Button title={t('Sign in')} variant="secondary" onPress={() => router.push('/sign-in')} />
      </View>

      <View style={[styles.barberBox, { borderColor: theme.border }]}>
        <T variant="heading">{t('Are you a barber?')}</T>
        <T variant="muted">
          {t('Get your own booking link, fill your chairs and cut down on no-shows. Free for your first month.')}
        </T>
        <Button
          title={t('Set up my shop')}
          variant="secondary"
          onPress={() => router.push({ pathname: '/sign-up', params: { role: 'barber' } })}
        />
      </View>

      {/* Shown in the other language, so people who can't read this one can still find it. */}
      <Button
        title={lang === 'ms' ? 'Switch to English' : 'Tukar ke Bahasa Melayu'}
        variant="ghost"
        onPress={() => setLang(lang === 'ms' ? 'en' : 'ms')}
      />
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

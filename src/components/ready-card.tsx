import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Bone, Button, Card, ErrorText, Skeleton, T } from '@/components/ui';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import {
  barberWithoutHours,
  nextStep,
  progressText,
  readyProgress,
  readySteps,
  type ReadyMemory,
  type ReadyStep,
  type ShopSetup,
  type StepId,
} from '@/lib/ready';
import type { Shop } from '@/lib/types';

/**
 * My shop's walk to a new shop's first booking: each step, done or not, in
 * the order to do them, each opening where it is done. Once all are done it
 * says the shop is ready, once.
 */
export function ReadyCard({
  shop,
  setup,
  memory,
  saidReady,
  failed,
  retrying,
  onRetry,
  onStep,
  onHide,
}: {
  shop: Shop;
  setup: ShopSetup | null;
  memory: ReadyMemory;
  saidReady: boolean;
  /** Couldn't be loaded, with nothing from last time to show. */
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
  onStep: (id: StepId) => void;
  /** Hidden for good, early or once it has said the shop is ready. */
  onHide: () => void;
}) {
  const theme = useTheme();

  if (saidReady) {
    return (
      <Card>
        <View role="status" accessibilityLiveRegion="polite" style={styles.readyRow}>
          <Ionicons name="checkmark-circle" size={28} color={theme.success} />
          <View style={styles.grow}>
            <T variant="heading">{t('Your shop is ready.')}</T>
            <T variant="muted">{t('Customers can book you now.')}</T>
          </View>
        </View>
        {shop.latitude == null ? (
          <T variant="small">{t('Add where the shop is any time under Shop details, so customers nearby find you first.')}</T>
        ) : null}
        <Button title={t('Got it')} variant="secondary" onPress={onHide} style={styles.start} />
      </Card>
    );
  }

  if (!setup) {
    return failed ? (
      <Card>
        <T variant="heading">{t('Get your shop ready')}</T>
        <ErrorText message={t('Couldn’t load your steps. Check your connection and try again.')} />
        <Button title={t('Try again')} variant="secondary" loading={retrying} onPress={onRetry} style={styles.start} />
      </Card>
    ) : (
      <Card>
        <Skeleton label={t('Loading your steps')} style={styles.bones}>
          <Bone width="60%" height={22} />
          <Bone width="30%" />
          {[0, 1, 2, 3, 4].map((i) => (
            <View key={i} style={styles.boneRow}>
              <Bone width={24} height={24} style={styles.round} />
              <Bone width={i % 2 ? '55%' : '70%'} />
            </View>
          ))}
        </Skeleton>
      </Card>
    );
  }

  const steps = readySteps(shop, setup, memory);
  const progress = readyProgress(steps);
  const next = nextStep(steps);

  return (
    <Card>
      <T variant="heading">{t('Get your shop ready')}</T>
      <View style={styles.progress}>
        <T variant="muted">{progressText(progress)}</T>
        {/* The words say it; the bar is only there to be seen. */}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          style={[styles.track, { backgroundColor: theme.border }]}>
          <View
            style={[
              styles.fill,
              { backgroundColor: theme.success, width: `${(progress.done / progress.total) * 100}%` },
            ]}
          />
        </View>
      </View>
      <View>
        {steps.map((step) => (
          <StepRow key={step.id} step={step} next={step.id === next} text={stepText(step, shop, setup)} onPress={() => onStep(step.id)} />
        ))}
      </View>
      <Button title={t('Hide these steps')} variant="ghost" onPress={onHide} style={styles.start} />
    </Card>
  );
}

function StepRow({
  step,
  next,
  text,
  onPress,
}: {
  step: ReadyStep;
  /** The one to do now, which stands out. */
  next: boolean;
  text: { title: string; detail: string };
  onPress: () => void;
}) {
  const theme = useTheme();
  const state = step.done ? t('done') : t('not done yet');
  return (
    <Pressable
      role="button"
      accessibilityLabel={`${text.title}, ${state}. ${text.detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.step, { borderTopColor: theme.border, opacity: pressed ? 0.7 : 1 }]}>
      <Ionicons
        name={step.done ? 'checkmark-circle' : next ? 'arrow-forward-circle' : 'ellipse-outline'}
        size={26}
        color={step.done ? theme.success : next ? theme.tint : theme.textSecondary}
      />
      <View style={styles.grow}>
        <T variant={next ? 'label' : 'body'} style={next ? styles.nextTitle : step.done ? { color: theme.textSecondary } : null}>
          {text.title}
        </T>
        <T variant="small">{text.detail}</T>
      </View>
      <Ionicons name="chevron-forward" size={20} color={theme.textSecondary} />
    </Pressable>
  );
}

/** Each step's name, and a line on what is there or what to do. */
function stepText(step: ReadyStep, shop: Shop, setup: ShopSetup): { title: string; detail: string } {
  switch (step.id) {
    case 'services':
      return {
        title: t('Add your services'),
        detail: !step.done
          ? t('What you offer, with prices, so customers have something to book.')
          : setup.services === 1
            ? t('1 service on your menu')
            : t('{count} services on your menu', { count: setup.services }),
      };
    case 'barbers': {
      const waiting = barberWithoutHours(setup);
      const working = setup.barbers.filter((b) => b.has_hours).map((b) => b.name);
      return {
        title: t('Add your barbers and their hours'),
        detail: step.done
          ? t('Hours set for {names}', { names: working.join(', ') })
          : waiting
            ? t('Set {name}’s working hours, so customers can pick a time.', { name: waiting.name })
            : t('Add yourself and anyone who cuts in your shop.'),
      };
    }
    case 'location':
      return {
        title: t('Set where the shop is (optional)'),
        detail: step.done ? t('Location set') : t('So customers nearby find you first, and Directions bring them to your door.'),
      };
    case 'live':
      return {
        title: t('Go live'),
        detail: step.done ? t('Customers can find you and book.') : t('So customers can find your shop and book.'),
      };
    case 'share':
      return {
        title: t('Share your booking link'),
        detail: step.done
          ? t('Shared. Keep it in your Instagram bio and WhatsApp status.')
          : shop.is_published
            ? t('Share or copy it, or print the poster for your counter.')
            : t('Once you’re live: share or copy it, or print the poster.'),
      };
  }
}

const styles = StyleSheet.create({
  readyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  grow: { flex: 1, gap: 2 },
  start: { alignSelf: 'flex-start' },
  progress: { gap: Spacing.xs },
  track: { height: 6, borderRadius: Radius.pill, overflow: 'hidden' },
  fill: { height: 6, borderRadius: Radius.pill },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 56,
    paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  nextTitle: { fontSize: 16, lineHeight: 22 },
  bones: { gap: Spacing.md },
  boneRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  round: { borderRadius: Radius.pill },
});

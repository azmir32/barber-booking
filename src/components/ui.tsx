// Small set of shared building blocks so every screen looks the same.

import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Fonts, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function Screen({
  children,
  scroll = true,
  edges = ['top'],
  onRefresh,
  footer,
  overlay,
  scrollRef,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: ('top' | 'bottom')[];
  /** Enables pull to refresh. */
  onRefresh?: () => Promise<unknown>;
  /** Stays at the bottom of the screen while the content scrolls, e.g. a confirm bar. */
  footer?: ReactNode;
  /** Floats over the content, e.g. an undo bar or an add button. Position it absolutely. */
  overlay?: ReactNode;
  scrollRef?: Ref<ScrollView>;
}) {
  const theme = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const inner = <View style={styles.content}>{children}</View>;
  const refreshControl = onRefresh ? (
    <RefreshControl
      refreshing={refreshing}
      tintColor={theme.accent}
      colors={[theme.accent]}
      onRefresh={async () => {
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }}
    />
  ) : undefined;
  return (
    <SafeAreaView
      edges={footer ? edges.filter((e) => e !== 'bottom') : edges}
      style={[styles.screen, { backgroundColor: theme.background }]}>
      {scroll ? (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}>
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
      {footer ? (
        <SafeAreaView edges={['bottom']} style={[styles.footer, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.footerInner}>{footer}</View>
        </SafeAreaView>
      ) : null}
      {overlay}
    </SafeAreaView>
  );
}

type Variant = 'title' | 'heading' | 'body' | 'muted' | 'small' | 'label';

export function T({ variant = 'body', style, ...rest }: TextProps & { variant?: Variant }) {
  const theme = useTheme();
  const color = variant === 'muted' || variant === 'small' ? theme.textSecondary : theme.text;
  return <Text style={[{ color, fontFamily: Fonts?.sans }, textStyles[variant], style]} {...rest} />;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const bg =
    variant === 'primary' ? theme.accent : variant === 'danger' ? theme.danger : variant === 'secondary' ? theme.chip : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? theme.accentText : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <T variant="label">{label}</T>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.textSecondary}
        style={[
          styles.input,
          { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
          props.multiline && { minHeight: 88, textAlignVertical: 'top' },
        ]}
        {...props}
      />
      {hint ? <T variant="small">{hint}</T> : null}
    </View>
  );
}

export function Card({ children, onPress, style }: { children: ReactNode; onPress?: () => void; style?: ViewStyle }) {
  const theme = useTheme();
  const cardStyle = [styles.card, { backgroundColor: theme.card, borderColor: theme.border }, style];
  if (!onPress) return <View style={cardStyle}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [...cardStyle, pressed && { opacity: 0.8 }]}>
      {children}
    </Pressable>
  );
}

export function Chip({
  label,
  sublabel,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  sublabel?: string;
  selected?: boolean;
  /** Shown faded and can't be tapped, e.g. a day the shop is closed. */
  disabled?: boolean;
  onPress?: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? theme.accent : theme.chip,
          borderColor: selected ? theme.accent : theme.border,
          opacity: disabled ? 0.45 : 1,
        },
      ]}>
      <Text style={[styles.chipText, { color: selected ? theme.accentText : theme.text }]}>{label}</Text>
      {sublabel ? (
        <Text style={[styles.chipSub, { color: selected ? theme.accentText : theme.textSecondary }]}>{sublabel}</Text>
      ) : null}
    </Pressable>
  );
}

/** A square button with just an icon, as big as a regular button so it is easy to hit. */
export function IconButton({
  icon,
  label,
  onPress,
  variant = 'secondary',
  color,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  /** Read out by screen readers, since there is no visible text. */
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  color?: string;
}) {
  const theme = useTheme();
  const bg = variant === 'primary' ? theme.accent : variant === 'secondary' ? theme.chip : 'transparent';
  const fg = color ?? (variant === 'primary' ? theme.accentText : theme.text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.iconButton, { backgroundColor: bg, opacity: pressed ? 0.8 : 1 }]}>
      <Ionicons name={icon} size={22} color={fg} />
    </Pressable>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const theme = useTheme();
  const color =
    tone === 'success' ? theme.success : tone === 'warning' ? theme.warning : tone === 'danger' ? theme.danger : theme.textSecondary;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="heading">{title}</T>
        {action}
      </Row>
      {children}
    </View>
  );
}

export function Loading() {
  const theme = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: theme.background }]}>
      <ActivityIndicator color={theme.accent} />
    </View>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  const theme = useTheme();
  if (!message) return null;
  return <Text style={{ color: theme.danger }}>{message}</Text>;
}

export function Empty({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <T variant="heading" style={{ textAlign: 'center' }}>
        {title}
      </T>
      {body ? (
        <T variant="muted" style={{ textAlign: 'center' }}>
          {body}
        </T>
      ) : null}
      {children}
    </View>
  );
}

const textStyles = StyleSheet.create({
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  muted: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1 },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.lg,
    gap: Spacing.lg,
  },
  button: {
    minHeight: 48,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  field: { gap: Spacing.xs },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: 16,
  },
  card: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
    minWidth: 64,
  },
  iconButton: {
    minWidth: 48,
    minHeight: 48,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: { borderTopWidth: StyleSheet.hairlineWidth },
  footerInner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  chipText: { fontSize: 15, fontWeight: '600' },
  chipSub: { fontSize: 12 },
  badge: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flexWrap: 'wrap' },
  section: { gap: Spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xxl },
});

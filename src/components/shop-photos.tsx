// The shop page's photos of its cuts: a strip of square thumbnails under its
// heading, a full-screen viewer to swipe through them with who did each and
// a way to book them, and each barber's photos from the barber step.

import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, T } from '@/components/ui';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { photoLabel, stripTileSize, type ShopPhoto } from '@/lib/photos';
import { photoUrl } from '@/lib/shop-photos';

type Named = { id: string; name: string };

const nameOf = (barbers: Named[], id: string | null) => (id ? barbers.find((b) => b.id === id)?.name : undefined);

/** The photos under the shop's heading, first photo first; a tap opens the viewer there. */
export function PhotoStrip({
  photos,
  barbers,
  onOpen,
}: {
  photos: ShopPhoto[];
  barbers: Named[];
  onOpen: (index: number) => void;
}) {
  const theme = useTheme();
  const window = useWindowDimensions();
  // Fixed from the screen's width, so the strip is its full height from the start and nothing below it moves.
  const size = stripTileSize(Math.min(window.width, MaxContentWidth) - 2 * Spacing.lg);
  return (
    <View style={{ gap: Spacing.sm }}>
      <T variant="heading">{t('Photos of their cuts')}</T>
      <FlatList
        horizontal
        data={photos}
        keyExtractor={(p) => p.id}
        // A scroll bar on the web, where there is no swipe with a mouse.
        showsHorizontalScrollIndicator={Platform.OS === 'web'}
        contentContainerStyle={{ gap: Spacing.sm, paddingBottom: Platform.OS === 'web' ? Spacing.xs : 0 }}
        initialNumToRender={4}
        windowSize={5}
        renderItem={({ item, index }) => {
          const barber = nameOf(barbers, item.barber_id);
          return (
            <Pressable
              role="button"
              accessibilityLabel={photoLabel(item.caption, barber, index, photos.length)}
              accessibilityHint={t('Opens the photo full screen')}
              onPress={() => onOpen(index)}
              style={({ pressed }) => ({ width: size, gap: 2, opacity: pressed ? 0.8 : 1 })}>
              <Image
                source={{ uri: photoUrl(item.thumb_path) }}
                contentFit="cover"
                accessible={false}
                recyclingKey={item.id}
                // The edge keeps a pale photo from running into the page.
                style={[styles.tile, { width: size, height: size, backgroundColor: theme.skeleton, borderColor: theme.border }]}
              />
              {/* Who did it, so the strip already says whose work is whose. */}
              <T variant="small" numberOfLines={1}>
                {barber ?? ' '}
              </T>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

/** In the barber step: a barber's photos, a few small ones and how many, opening the viewer at theirs. */
export function BarberPhotosButton({
  name,
  photos,
  onPress,
}: {
  name: string;
  photos: ShopPhoto[];
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      role="button"
      accessibilityLabel={t('Photos of {name}’s cuts ({count})', { name, count: photos.length })}
      onPress={onPress}
      style={({ pressed }) => [styles.barberPhotos, { opacity: pressed ? 0.8 : 1 }]}>
      <View style={styles.minis}>
        {photos.slice(0, 3).map((p, i) => (
          <Image
            key={p.id}
            source={{ uri: photoUrl(p.thumb_path) }}
            contentFit="cover"
            accessible={false}
            // Overlapping a little, like a fanned stack.
            style={[styles.mini, { marginLeft: i ? -8 : 0, backgroundColor: theme.skeleton, borderColor: theme.card }]}
          />
        ))}
      </View>
      <T variant="label" style={{ color: theme.tint, flexShrink: 1 }}>
        {t('Photos ({count})', { count: photos.length })}
      </T>
    </Pressable>
  );
}

/** Previous or Next: as big as a button, and dimmed, still in place, at either end. */
function StepButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: 'chevron-back' | 'chevron-forward';
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      aria-disabled={disabled}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.step,
        { backgroundColor: theme.card, borderColor: theme.inputBorder, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 },
      ]}>
      <Ionicons aria-hidden name={icon} size={22} color={theme.text} />
    </Pressable>
  );
}

/** Moves a screen reader, or the keyboard on the web, to a button that just appeared. */
function focusOn(node: View | null) {
  if (!node) return;
  if (Platform.OS === 'web') (node as unknown as HTMLElement).focus?.();
  else {
    const tag = findNodeHandle(node);
    if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
  }
}

/**
 * The photos full screen, one at a time: swipe or Previous and Next, the
 * caption and who did the cut, and Book them. A dialog that starts on Close,
 * so a screen reader user always knows the way out.
 */
export function PhotoViewer({
  photos,
  start,
  barbers,
  onBook,
  onClose,
}: {
  photos: ShopPhoto[];
  start: number;
  /** The shop's barbers customers can book; a photo by anyone else has no Book button. */
  barbers: Named[];
  onBook: ((barberId: string) => void) | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(start);
  const pages = useRef<ScrollView>(null);
  const close = useRef<View>(null);
  const placed = useRef(false);

  useEffect(() => {
    // After the dialog has taken focus for itself, as it does on the web.
    const timer = setTimeout(() => focusOn(close.current), 100);
    return () => clearTimeout(timer);
  }, []);

  const go = (next: number) => {
    const to = Math.max(0, Math.min(photos.length - 1, next));
    setIndex(to);
    pages.current?.scrollTo({ x: to * width, animated: true });
  };

  const photo = photos[index];
  const barber = photo ? nameOf(barbers, photo.barber_id) : undefined;
  if (!photo) return null;
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View role="dialog" aria-modal aria-label={t('Photos of their cuts')} style={styles.viewer}>
        <SafeAreaView edges={['top']} style={styles.top}>
          <T role="status" accessibilityLiveRegion="polite" style={styles.counter}>
            {t('{n} of {total}', { n: index + 1, total: photos.length })}
          </T>
          <Pressable
            ref={close}
            role="button"
            accessibilityLabel={t('Close')}
            onPress={onClose}
            hitSlop={4}
            style={({ pressed }) => [styles.close, { opacity: pressed ? 0.7 : 1 }]}>
            <Ionicons aria-hidden name="close" size={28} color="#FFFFFF" />
          </Pressable>
        </SafeAreaView>
        <ScrollView
          ref={pages}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onLayout={() => {
            // Opens on the photo tapped.
            if (placed.current) return;
            placed.current = true;
            pages.current?.scrollTo({ x: start * width, animated: false });
          }}
          onScroll={(e) => {
            const at = Math.round(e.nativeEvent.contentOffset.x / width);
            if (placed.current && at !== index && at >= 0 && at < photos.length) setIndex(at);
          }}
          scrollEventThrottle={50}
          style={{ flex: 1 }}>
          {photos.map((p, i) => (
            <View key={p.id} style={{ width, height: '100%' }}>
              {/* Only the photos either side are loaded, not all 24. */}
              {Math.abs(i - index) <= 1 ? (
                <Image
                  source={{ uri: photoUrl(p.path) }}
                  placeholder={{ uri: photoUrl(p.thumb_path) }}
                  contentFit="contain"
                  accessibilityLabel={photoLabel(p.caption, nameOf(barbers, p.barber_id), i, photos.length)}
                  style={{ flex: 1 }}
                />
              ) : null}
            </View>
          ))}
        </ScrollView>
        <SafeAreaView edges={['bottom']} style={{ backgroundColor: theme.card }}>
          <View style={styles.panelInner}>
            {photo.caption ? <T>{photo.caption}</T> : null}
            {barber ? <T variant="muted">{t('Cut by {name}', { name: barber })}</T> : null}
            <View style={styles.actions}>
              <StepButton icon="chevron-back" label={t('Previous photo')} disabled={index === 0} onPress={() => go(index - 1)} />
              <View style={{ flex: 1 }}>
                {barber && onBook ? (
                  <Button title={t('Book {name}', { name: barber })} onPress={() => onBook(photo.barber_id!)} />
                ) : null}
              </View>
              <StepButton
                icon="chevron-forward"
                label={t('Next photo')}
                disabled={index === photos.length - 1}
                onPress={() => go(index + 1)}
              />
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: Radius.md, borderWidth: 1 },
  barberPhotos: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    minHeight: 44,
    alignSelf: 'flex-start',
  },
  minis: { flexDirection: 'row' },
  mini: { width: 32, height: 32, borderRadius: Radius.sm, borderWidth: 2 },
  viewer: { flex: 1, backgroundColor: '#000000' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.sm },
  counter: { color: '#FFFFFF', paddingHorizontal: Spacing.sm },
  close: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  panelInner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  step: {
    minWidth: 48,
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

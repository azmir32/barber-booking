import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { Bone, Button, Card, ErrorText, Row, Skeleton, T } from '@/components/ui';
import { APP_NAME } from '@/constants/brand';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { gridLayout, MAX_PHOTOS, photoLabel } from '@/lib/photos';
import { addPhoto, photoUrl, pickPhotos, type OwnPhoto } from '@/lib/shop-photos';

type Progress = { n: number; total: number; done: number };

/**
 * My shop's "Photos of your cuts": the shop's photos as customers see them
 * in order, each opening its own screen to name the barber, write a caption,
 * move it first or remove it, and Add photos.
 */
export function ShopPhotosCard({
  shopId,
  photos,
  change,
  loadError,
  reload,
}: {
  shopId: string;
  /** Null until the first answer, with nothing kept from last time. */
  photos: OwnPhoto[] | null;
  change: (next: (list: OwnPhoto[]) => OwnPhoto[]) => void;
  loadError: string | null;
  reload: () => void;
}) {
  const theme = useTheme();
  const window = useWindowDimensions();
  // The screen's and the card's padding and edges; measured once laid out.
  const [width, setWidth] = useState(Math.min(window.width, MaxContentWidth) - 4 * Spacing.lg - 2);
  const grid = gridLayout(width);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The phone said no to the photo library: once (it may ask again), or for good (only Settings can change it).
  const [denied, setDenied] = useState<'once' | 'settings' | null>(null);
  const count = photos?.length ?? 0;
  const full = count >= MAX_PHOTOS;

  async function add() {
    setProblem(null);
    setDenied(null);
    const room = MAX_PHOTOS - count;
    const picked = await pickPhotos(room);
    if (picked.kind === 'denied') return setDenied(picked.canAskAgain ? 'once' : 'settings');
    if (picked.kind === 'cancelled') return;
    // The web's file picker has no limit of its own.
    const assets = picked.assets.slice(0, room);
    const failures: string[] = [];
    for (const [i, asset] of assets.entries()) {
      const total = assets.length;
      setProgress({ n: i + 1, total, done: i / total });
      const result = await addPhoto(shopId, asset, (part) => setProgress({ n: i + 1, total, done: (i + part) / total }));
      if (result.photo) change((list) => [...list, result.photo]);
      else failures.push(result.error);
    }
    setProgress(null);
    const left = picked.assets.length - assets.length;
    const notes = [
      failures.length === 0
        ? null
        : assets.length === 1
          ? failures[0]
          : t('{count} of {total} photos couldn’t be added. {reason}', {
              count: failures.length,
              total: assets.length,
              reason: failures[0],
            }),
      left > 0 ? t('Only {count} more fit, so the rest weren’t added.', { count: room }) : null,
    ].filter(Boolean);
    setProblem(notes.length ? notes.join(' ') : null);
  }

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="heading">{t('Photos of your cuts')}</T>
        {photos ? <T variant="small">{t('{count} of {max}', { count, max: MAX_PHOTOS })}</T> : null}
      </Row>
      {photos === null ? (
        loadError ? (
          <>
            <ErrorText message={t('Couldn’t load your photos. {reason}', { reason: loadError })} />
            <Button title={t('Try again')} variant="secondary" onPress={reload} />
          </>
        ) : (
          <Skeleton label={t('Loading your photos')} style={{ flexDirection: 'row', gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <Bone key={i} width={grid.size} height={grid.size} style={{ borderRadius: Radius.sm }} />
            ))}
          </Skeleton>
        )
      ) : count === 0 ? (
        <T variant="muted">
          {t('Customers see these on your shop page and pick a barber by their work. Add your best fades, beards and kids’ cuts.')}
        </T>
      ) : (
        <View style={styles.grid} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {photos.map((photo, i) => {
            const label = photoLabel(photo.caption, photo.barber?.name, i, count);
            return (
              <Pressable
                key={photo.id}
                role="link"
                accessibilityLabel={label}
                accessibilityHint={t('Name the barber, write a caption, move it first or remove it')}
                onPress={() => router.push({ pathname: '/barber/photo', params: { id: photo.id } })}
                style={({ pressed }) => [{ width: grid.size, gap: 2, opacity: pressed ? 0.8 : 1 }]}>
                <Image
                  source={{ uri: photoUrl(photo.thumb_path) }}
                  contentFit="cover"
                  accessible={false}
                  style={[styles.tile, { width: grid.size, height: grid.size, backgroundColor: theme.skeleton, borderColor: theme.border }]}
                />
                <T variant="small" numberOfLines={1}>
                  {photo.barber?.name ?? ' '}
                </T>
              </Pressable>
            );
          })}
        </View>
      )}
      {progress ? (
        <View style={{ gap: Spacing.xs }}>
          <T variant="small" role="status" accessibilityLiveRegion="polite">
            {t('Adding photo {n} of {total}…', { n: progress.n, total: progress.total })}
          </T>
          <View
            role="progressbar"
            aria-label={t('Adding photos')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress.done * 100)}
            style={[styles.track, { backgroundColor: theme.skeleton }]}>
            <View style={[styles.fill, { width: `${Math.max(4, progress.done * 100)}%`, backgroundColor: theme.tint }]} />
          </View>
        </View>
      ) : null}
      {denied ? (
        <Row style={{ flexWrap: 'nowrap' }}>
          <T variant="small" role="alert" accessibilityLiveRegion="polite" style={{ flex: 1 }}>
            {denied === 'settings'
              ? t('{app} can’t open your photos. Allow photo access in Settings, then tap Add photos again.', {
                  app: APP_NAME,
                })
              : t('{app} needs to open your photos to add them. Tap Add photos and allow it.', { app: APP_NAME })}
          </T>
          {denied === 'settings' && Platform.OS !== 'web' ? (
            <Button title={t('Settings')} variant="ghost" onPress={() => Linking.openSettings()} />
          ) : null}
        </Row>
      ) : null}
      <ErrorText message={problem} />
      {full ? (
        <T variant="small">{t('24 photos is the most a shop can have. Remove one to add another.')}</T>
      ) : photos ? (
        <Button
          title={t('+ Add photos')}
          accessibilityLabel={t('Add photos')}
          variant={count === 0 ? 'primary' : 'secondary'}
          loading={progress != null}
          onPress={add}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { borderRadius: Radius.sm, borderWidth: 1 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
});

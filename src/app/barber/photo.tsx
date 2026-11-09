import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Bone, Button, Chip, Empty, ErrorText, Field, Row, Screen, Section, Skeleton, T } from '@/components/ui';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { CAPTION_MAX_LENGTH, firstPlace, inShownOrder, PHOTO_COLUMNS, photoCaption, photoLabel } from '@/lib/photos';
import { photoUrl, removePhoto, useShopPhotos, type OwnPhoto } from '@/lib/shop-photos';
import { errorMessage, supabase } from '@/lib/supabase';
import type { Barber } from '@/lib/types';

/** One of My shop's photos: who did the cut, its caption, first in line, or gone. */
export default function EditPhoto() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { shop } = useMyShop();
  const { photos, change, error, reload } = useShopPhotos(shop?.id);
  const [barbers, setBarbers] = useState<Pick<Barber, 'id' | 'name'>[] | null>(null);
  const shopId = shop?.id;
  useEffect(() => {
    if (!shopId) return;
    supabase
      .from('barbers')
      .select('id, name')
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .order('sort_order')
      .order('name')
      .then(({ data }) => setBarbers(data ?? []));
  }, [shopId]);

  const index = photos?.findIndex((p) => p.id === id) ?? -1;
  if (!photos || !barbers) {
    if (photos === null && error) {
      return (
        <Screen edges={[]}>
          <Empty title={t('Couldn’t load this photo')} body={error}>
            <Button title={t('Try again')} variant="secondary" onPress={reload} />
          </Empty>
        </Screen>
      );
    }
    return (
      <Screen edges={[]}>
        <Skeleton label={t('Loading the photo')}>
          <Bone height={320} style={{ borderRadius: Radius.md }} />
          <Bone width="50%" height={20} />
          <Row>
            <Bone width={96} height={48} />
            <Bone width={96} height={48} />
          </Row>
        </Skeleton>
      </Screen>
    );
  }
  if (index < 0) {
    return (
      <Screen edges={[]}>
        <Empty title={t('This photo has been removed')}>
          <Button title={t('Back to My shop')} onPress={() => router.back()} />
        </Empty>
      </Screen>
    );
  }
  return <PhotoForm key={id} photo={photos[index]} index={index} photos={photos} barbers={barbers} change={change} />;
}

function PhotoForm({
  photo,
  index,
  photos,
  barbers,
  change,
}: {
  photo: OwnPhoto;
  index: number;
  photos: OwnPhoto[];
  barbers: Pick<Barber, 'id' | 'name'>[];
  change: (next: (list: OwnPhoto[]) => OwnPhoto[]) => void;
}) {
  const theme = useTheme();
  const [barberId, setBarberId] = useState(photo.barber_id);
  const [caption, setCaption] = useState(photo.caption ?? '');
  const [busy, setBusy] = useState<'save' | 'first' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A barber no longer on the team stays named here until the owner picks another.
  const choices =
    photo.barber_id && photo.barber && !barbers.some((b) => b.id === photo.barber_id)
      ? [...barbers, { id: photo.barber_id, name: photo.barber.name }]
      : barbers;

  /** Saves who did it and the caption, and with `first`, puts it first; then back to My shop. */
  async function save(first: boolean) {
    setBusy(first ? 'first' : 'save');
    setError(null);
    const { data, error: failed } = await supabase
      .from('shop_photos')
      .update({
        barber_id: barberId,
        caption: photoCaption(caption),
        ...(first ? { sort_order: firstPlace(photos) } : {}),
      })
      .eq('id', photo.id)
      .select(`${PHOTO_COLUMNS}, barber:barbers(name)`)
      .single();
    setBusy(null);
    if (failed || !data) return setError(errorMessage(failed));
    const saved = data as unknown as OwnPhoto;
    change((list) => inShownOrder(list.map((p) => (p.id === saved.id ? saved : p))));
    router.back();
  }

  async function remove() {
    const ok = await confirmAction(
      t('Remove this photo?'),
      t('Customers won’t see it on your shop page any more. This can’t be undone.'),
      t('Remove photo'),
    );
    if (!ok) return;
    setBusy('remove');
    setError(null);
    const failed = await removePhoto(photo);
    setBusy(null);
    if (failed) return setError(failed);
    change((list) => list.filter((p) => p.id !== photo.id));
    router.back();
  }

  return (
    <Screen edges={[]}>
      <View
        style={{
          width: '100%',
          // The photo's own shape, letterboxed if it is very tall, so the page doesn't jump as it loads.
          aspectRatio: Math.max(photo.width / photo.height, 0.8),
          borderRadius: Radius.md,
          overflow: 'hidden',
          backgroundColor: theme.skeleton,
        }}>
        <Image
          source={{ uri: photoUrl(photo.path) }}
          placeholder={{ uri: photoUrl(photo.thumb_path) }}
          contentFit="contain"
          accessibilityLabel={photoLabel(photo.caption, photo.barber?.name, index, photos.length)}
          style={{ flex: 1 }}
        />
      </View>
      <T variant="small">
        {index === 0
          ? t('Customers see this photo first.')
          : t('Photo {n} of {total} on your shop page.', { n: index + 1, total: photos.length })}
      </T>

      <Section title={t('Who did this cut?')}>
        <Row role="radiogroup" accessibilityLabel={t('Who did this cut?')}>
          <Chip label={t('Not named')} selected={barberId === null} onPress={() => setBarberId(null)} />
          {choices.map((b) => (
            <Chip key={b.id} label={b.name} selected={barberId === b.id} onPress={() => setBarberId(b.id)} />
          ))}
        </Row>
        <T variant="small">{t('Customers can book this barber straight from the photo.')}</T>
      </Section>

      <Field
        label={t('Caption (optional)')}
        value={caption}
        onChangeText={setCaption}
        maxLength={CAPTION_MAX_LENGTH}
        placeholder={t('e.g. Skin fade with a hard part')}
        hint={t('One short line, shown under the photo.')}
      />

      <ErrorText message={error} />
      <View style={{ gap: Spacing.sm }}>
        <Button title={t('Save')} onPress={() => save(false)} loading={busy === 'save'} disabled={busy != null && busy !== 'save'} />
        {index > 0 ? (
          <Button
            title={t('Save and move to first')}
            variant="secondary"
            onPress={() => save(true)}
            loading={busy === 'first'}
            disabled={busy != null && busy !== 'first'}
          />
        ) : null}
        <Button
          title={t('Remove photo')}
          variant="secondary"
          tone="danger"
          onPress={remove}
          loading={busy === 'remove'}
          disabled={busy != null && busy !== 'remove'}
        />
      </View>
    </Screen>
  );
}

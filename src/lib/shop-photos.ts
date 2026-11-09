// Adding, showing and removing the photos of a shop's cuts. Each is resized
// on the phone before it goes (at most 1600 px, as a JPEG of a few hundred
// KB) with a thumbnail of about 400 px beside it for strips and grids, as
// Supabase's own image resizing needs a paid plan. The files go to the
// shop-photos bucket in the shop's folder, then the row that lists them.

import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { useAuth } from '@/lib/auth';
import { t } from '@/lib/lang';
import {
  base64Bytes,
  MAX_PHOTO_FILES,
  MAX_PHOTOS,
  PHOTO_BUCKET,
  PHOTO_COLUMNS,
  PHOTO_QUALITY,
  PHOTO_UPLOAD,
  photoPaths,
  refusedUpload,
  resizeTarget,
  THUMB_QUALITY,
  thumbTarget,
  uploadProblem,
  type ShopPhoto,
} from '@/lib/photos';
import { keepPhotos, keptPhotos } from '@/lib/shop-cards';
import { errorMessage, publicFileUrl, supabase } from '@/lib/supabase';

/** A photo's link on Supabase's CDN, for expo-image. */
export const photoUrl = (path: string) => publicFileUrl(PHOTO_BUCKET, path);

/** A photo as its owner lists them, with the name of the barber who did it. */
export type OwnPhoto = ShopPhoto & { barber: { name: string } | null };

export type Picked =
  | { kind: 'picked'; assets: ImagePickerAsset[] }
  | { kind: 'cancelled' }
  /** The phone said no to the photo library; canAskAgain false means only Settings can change it. */
  | { kind: 'denied'; canAskAgain: boolean };
type ImagePickerAsset = ImagePicker.ImagePickerAsset;

/** Asks for the photo library (only now, on the tap), then lets the owner pick up to `limit`. */
export async function pickPhotos(limit: number): Promise<Picked> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { kind: 'denied', canAskAgain: permission.canAskAgain };
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    // Resized and compressed below, so nothing is lost twice.
    quality: 1,
  });
  if (result.canceled || !result.assets?.length) return { kind: 'cancelled' };
  return { kind: 'picked', assets: result.assets };
}

type Saved = { bytes: Uint8Array; width: number; height: number };

async function saveJpeg(image: ImageRef, compress: number): Promise<Saved> {
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
  if (!saved.base64) throw new Error('No image data');
  return { bytes: base64Bytes(saved.base64), width: saved.width, height: saved.height };
}

/** The photo at most 1600 px on its long side and its thumbnail, both as JPEG. */
async function resizePhoto(asset: ImagePickerAsset): Promise<{ photo: Saved; thumb: Saved }> {
  const refs: { release(): void }[] = [];
  try {
    const context = ImageManipulator.manipulate(asset.uri);
    refs.push(context);
    // On a phone the picked size can be before turning the photo upright, so it is loaded first to measure.
    let size = Platform.OS === 'web' ? resizeTarget(asset) : null;
    if (!size) {
      const original = await context.renderAsync();
      refs.push(original);
      size = resizeTarget(original);
    }
    if (!size) throw new Error('Unknown image size');
    const image = await context.resize(size).renderAsync();
    refs.push(image);
    const photo = await saveJpeg(image, PHOTO_QUALITY);
    const thumbContext = ImageManipulator.manipulate(image);
    refs.push(thumbContext);
    const thumbImage = await thumbContext.resize(thumbTarget(photo) ?? photo).renderAsync();
    refs.push(thumbImage);
    return { photo, thumb: await saveJpeg(thumbImage, THUMB_QUALITY) };
  } finally {
    for (const ref of refs) ref.release();
  }
}

/**
 * Adds one picked photo to the shop: resized, both files sent, then listed
 * last. `step` says how far it got, for the progress bar. Files sent for a
 * photo that then couldn't be listed are taken back.
 */
export async function addPhoto(
  shopId: string,
  asset: ImagePickerAsset,
  step: (done: number) => void,
): Promise<{ photo: OwnPhoto; error?: undefined } | { photo?: undefined; error: string }> {
  let files: Awaited<ReturnType<typeof resizePhoto>>;
  try {
    files = await resizePhoto(asset);
  } catch {
    return { error: t('Couldn’t read this photo. Try another one.') };
  }
  step(1 / 3);
  const { path, thumb_path } = photoPaths(shopId);
  const bucket = supabase.storage.from(PHOTO_BUCKET);
  const sent = await bucket.upload(path, files.photo.bytes.buffer as ArrayBuffer, PHOTO_UPLOAD);
  const thumbSent = sent.error
    ? null
    : await bucket.upload(thumb_path, files.thumb.bytes.buffer as ArrayBuffer, PHOTO_UPLOAD);
  const failed = sent.error ?? thumbSent?.error;
  if (failed) {
    // Refused to the owner too once the folder is full: told apart by counting it, before the photo's file goes.
    const full = refusedUpload(failed) && (await folderFull(shopId));
    if (!sent.error) bucket.remove([path]);
    if (full) {
      return { error: t('Your shop has too many photo files waiting to be cleared away. Remove a photo to make room, or try again tomorrow.') };
    }
    return { error: uploadProblem(failed) ?? errorMessage(failed) };
  }
  step(2 / 3);
  const { data, error } = await supabase
    .from('shop_photos')
    .insert({ shop_id: shopId, path, thumb_path, width: files.photo.width, height: files.photo.height })
    .select(`${PHOTO_COLUMNS}, barber:barbers(name)`)
    .single();
  if (error || !data) {
    // Left behind if this fails too; scripts/clean-photos.mjs clears such files a day later.
    bucket.remove([path, thumb_path]);
    return { error: errorMessage(error) };
  }
  step(1);
  return { photo: data as unknown as OwnPhoto };
}

/** Whether the shop's folder holds as many files as Storage lets it (MAX_PHOTO_FILES). */
async function folderFull(shopId: string) {
  const { data } = await supabase.storage.from(PHOTO_BUCKET).list(shopId, { limit: MAX_PHOTO_FILES });
  return (data?.length ?? 0) >= MAX_PHOTO_FILES;
}

/** Removes a photo from the shop, then its files; resolves to why it couldn't, or null. */
export async function removePhoto(photo: Pick<ShopPhoto, 'id' | 'path' | 'thumb_path'>): Promise<string | null> {
  const { error } = await supabase.from('shop_photos').delete().eq('id', photo.id);
  if (error) return errorMessage(error);
  // Files that don't go now are cleared a day later (scripts/clean-photos.mjs).
  await supabase.storage.from(PHOTO_BUCKET).remove([photo.path, photo.thumb_path]);
  return null;
}

/**
 * Before an owner deletes their account: their shop's photos and files, as
 * only the owner can remove the files and the account's deletion takes the
 * rows but not them. Resolves to why it couldn't, or null.
 */
export async function removeAllShopPhotos(ownerId: string): Promise<string | null> {
  const shop = await supabase.from('shops').select('id').eq('owner_id', ownerId).maybeSingle();
  if (shop.error) return errorMessage(shop.error);
  if (!shop.data) return null;
  const { data, error } = await supabase.from('shop_photos').delete().eq('shop_id', shop.data.id).select('path, thumb_path');
  if (error) return errorMessage(error);
  const paths = ((data ?? []) as Pick<ShopPhoto, 'path' | 'thumb_path'>[]).flatMap((p) => [p.path, p.thumb_path]);
  if (paths.length) await supabase.storage.from(PHOTO_BUCKET).remove(paths);
  return null;
}

/**
 * The shop's photos on a photo's own screen: the ones My shop's cards have
 * (shop_cards brings them), else asked for, as when the screen is opened by
 * its link. A change made here goes into My shop's kept cards too, so it
 * shows there on going back, before My shop asks again.
 */
export function useShopPhotos(shopId: string | undefined) {
  const uid = useAuth().session?.user.id;
  const [photos, setPhotos] = useState<OwnPhoto[] | null>(() => (uid && shopId ? keptPhotos(uid, shopId) : null));
  const [error, setError] = useState<string | null>(null);

  // Only the latest ask's answer counts, so one that failed offline can't land after one that worked.
  const asked = useRef(0);
  const load = useCallback(async () => {
    if (!shopId) return;
    const n = ++asked.current;
    const { data, error } = await supabase
      .from('shop_photos')
      .select(`${PHOTO_COLUMNS}, barber:barbers(name)`)
      .eq('shop_id', shopId)
      .order('sort_order')
      .order('created_at')
      .order('id')
      .limit(MAX_PHOTOS);
    if (n !== asked.current) return;
    if (error || !data) return setError(errorMessage(error));
    const list = data as unknown as OwnPhoto[];
    setPhotos(list);
    setError(null);
    if (uid) keepPhotos(uid, shopId, list);
  }, [shopId, uid]);

  const missing = photos === null;
  useFocusEffect(
    useCallback(() => {
      if (missing) load();
    }, [missing, load]),
  );

  /** A change made here, shown at once and kept in My shop's cards. */
  const change = useCallback(
    (next: (list: OwnPhoto[]) => OwnPhoto[]) =>
      setPhotos((list) => {
        const updated = next(list ?? []);
        if (uid && shopId) keepPhotos(uid, shopId, updated);
        return updated;
      }),
    [uid, shopId],
  );

  return { photos, change, error, reload: load };
}

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

import { appCache } from '@/lib/app-cache';
import { useAuth } from '@/lib/auth';
import { cacheKey } from '@/lib/cache';
import { t } from '@/lib/lang';
import {
  base64Bytes,
  MAX_PHOTOS,
  PHOTO_BUCKET,
  PHOTO_COLUMNS,
  PHOTO_QUALITY,
  photoPaths,
  resizeTarget,
  THUMB_QUALITY,
  thumbTarget,
  uploadProblem,
  type ShopPhoto,
} from '@/lib/photos';
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

const UPLOAD = { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false };

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
  const sent = await bucket.upload(path, files.photo.bytes.buffer as ArrayBuffer, UPLOAD);
  const thumbSent = sent.error ? null : await bucket.upload(thumb_path, files.thumb.bytes.buffer as ArrayBuffer, UPLOAD);
  const failed = sent.error ?? thumbSent?.error;
  if (failed) {
    if (!sent.error) bucket.remove([path]);
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
 * My shop's photos: last time's at once, then the server's, asked for on
 * every visit so a photo changed on its own screen shows on coming back.
 */
export function useShopPhotos(shopId: string | undefined) {
  const uid = useAuth().session?.user.id;
  const key = uid && shopId ? cacheKey(uid, 'shop-photos', shopId) : null;
  const [kept] = useState(() => (key ? appCache.peek<OwnPhoto[]>(key) : null));
  const [photos, setPhotos] = useState<OwnPhoto[] | null>(kept?.data ?? null);
  const [savedAt, setSavedAt] = useState(kept?.at ?? 0);
  const [fromCache, setFromCache] = useState(Boolean(kept));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the latest ask's answer counts, so one that failed offline can't land after one that worked.
  const asked = useRef(0);
  const load = useCallback(async () => {
    if (!shopId) return;
    const n = ++asked.current;
    setLoading(true);
    const { data, error } = await supabase
      .from('shop_photos')
      .select(`${PHOTO_COLUMNS}, barber:barbers(name)`)
      .eq('shop_id', shopId)
      .order('sort_order')
      .order('created_at')
      .order('id')
      .limit(MAX_PHOTOS);
    if (n !== asked.current) return;
    setLoading(false);
    if (error || !data) return setError(errorMessage(error));
    const list = data as unknown as OwnPhoto[];
    setPhotos(list);
    setError(null);
    setSavedAt(Date.now());
    setFromCache(false);
    if (key) appCache.write(key, list);
  }, [shopId, key]);

  // Back from a photo's own screen, its changes are in the cache before the server answers.
  useFocusEffect(
    useCallback(() => {
      const latest = key ? appCache.peek<OwnPhoto[]>(key) : null;
      if (latest) setPhotos(latest.data);
      load();
    }, [key, load]),
  );

  /** A change made here, shown at once and kept for next time. */
  const change = useCallback(
    (next: (list: OwnPhoto[]) => OwnPhoto[]) =>
      setPhotos((list) => {
        const updated = next(list ?? []);
        if (key) appCache.write(key, updated);
        return updated;
      }),
    [key],
  );

  return {
    photos,
    change,
    loading,
    /** Last visit's photos, with the server's on their way. */
    refreshing: fromCache && loading,
    /** When the photos on screen are from, when asking again failed; null otherwise. */
    staleSince: error != null && savedAt ? savedAt : null,
    error,
    reload: load,
  };
}

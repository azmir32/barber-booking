// Photos of a shop's cuts: the sizes they are kept at, how they are laid
// out, and what screen readers hear for each. Kept free of React Native
// imports so a plain node test can check the sums.

import { t } from './lang.ts';

/** The most photos a shop keeps, as the database allows. */
export const MAX_PHOTOS = 24;
/**
 * The most files a shop's folder holds, as Storage's policy allows: two for
 * each photo, and a few more for photos on their way or files not yet cleared.
 */
export const MAX_PHOTO_FILES = 2 * MAX_PHOTOS + 8;
/** Longest caption, as the database allows. */
export const CAPTION_MAX_LENGTH = 60;
/** The Storage bucket the files are in. */
export const PHOTO_BUCKET = 'shop-photos';
/** A photo's long side at most, so it is a few hundred KB and sharp on any phone. */
export const PHOTO_MAX_SIDE = 1600;
/** A thumbnail's short side: a square cut from it stays sharp at 160 points on a 2.5x screen. */
export const THUMB_SHORT_SIDE = 400;
/** JPEG quality for the photo and its thumbnail. */
export const PHOTO_QUALITY = 0.8;
export const THUMB_QUALITY = 0.7;

/**
 * How each file is sent. Never over another (each photo is a new name), and
 * kept by browsers and Supabase's CDN for a day: on the free plan the CDN
 * isn't cleared when a file is removed, so a removed photo can still be
 * reached by its link for up to that long.
 */
export const PHOTO_UPLOAD = { contentType: 'image/jpeg', cacheControl: '86400', upsert: false };

/** What the app reads of a photo, in the order shops show them. */
export const PHOTO_COLUMNS = 'id, barber_id, caption, path, thumb_path, width, height, sort_order';

export type ShopPhoto = {
  id: string;
  barber_id: string | null;
  caption: string | null;
  /** The photo and its thumbnail, in the shop-photos bucket. */
  path: string;
  thumb_path: string;
  width: number;
  height: number;
  sort_order: number;
};

type Size = { width: number; height: number };

/**
 * The size to save a picked image at: its long side at most `max`, the
 * same shape, never bigger than it came. Null when its size is unknown.
 */
export function resizeTarget({ width, height }: Size, max = PHOTO_MAX_SIDE): Size | null {
  if (!(width > 0 && height > 0)) return null;
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * A thumbnail's size: its short side `short`, the same shape, never bigger
 * than the photo, so the square cut from it for strips and grids is sharp.
 */
export function thumbTarget({ width, height }: Size, short = THUMB_SHORT_SIDE): Size | null {
  if (!(width > 0 && height > 0)) return null;
  const scale = Math.min(1, short / Math.min(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Square tiles across a width, with `gap` between: as many columns as fit
 * tiles of at least `min`, between 3 and 4, so a grid of 24 is never a long
 * column of big photos nor a crowd of tiny ones.
 */
export function gridLayout(width: number, { min = 88, gap = 8 }: { min?: number; gap?: number } = {}) {
  const fit = Math.floor((width + gap) / (min + gap));
  const columns = Math.min(4, Math.max(3, fit));
  const size = Math.max(1, Math.floor((width - gap * (columns - 1)) / columns));
  return { columns, size };
}

/**
 * A strip's square tile, so about two and a half show across the width and
 * the half one says there is more to swipe; never bigger than `max`.
 */
export function stripTileSize(width: number, { gap = 8, max = 160, min = 96 }: { gap?: number; max?: number; min?: number } = {}) {
  return Math.round(Math.min(max, Math.max(min, (width - 2 * gap) / 2.5)));
}

/** The order number that puts a photo before all the others. */
export function firstPlace(photos: Pick<ShopPhoto, 'sort_order'>[]): number {
  return photos.length ? Math.min(...photos.map((p) => p.sort_order)) - 1 : 0;
}

/** Shops' photos in the order they show them, as the database sorts them. */
export function inShownOrder<P extends Pick<ShopPhoto, 'sort_order' | 'id'>>(photos: P[]): P[] {
  return [...photos].sort((a, b) => a.sort_order - b.sort_order);
}

/** How many photos each barber has. */
export function photoCounts(photos: Pick<ShopPhoto, 'barber_id'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of photos) if (p.barber_id) counts.set(p.barber_id, (counts.get(p.barber_id) ?? 0) + 1);
  return counts;
}

/**
 * What a caption box holds, as the database takes it: one line, spaces
 * tidied, cut to 60 characters; null when blank.
 */
export function photoCaption(typed: string): string | null {
  const line = typed.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/^ +| +$/g, '');
  return [...line].slice(0, CAPTION_MAX_LENGTH).join('').replace(/ +$/, '') || null;
}

/**
 * What a screen reader hears for a photo: its caption and who did it, or
 * else where it is in the list.
 */
export function photoLabel(caption: string | null, barber: string | null | undefined, index: number, total: number): string {
  const what = caption ?? t('Photo {n} of {total}', { n: index + 1, total });
  return barber ? t('{photo}, cut by {barber}', { photo: what, barber }) : what;
}

/** New files' names in the shop's folder: random, so the CDN and phones can keep them for good. */
export function photoPaths(shopId: string, random: () => number = Math.random): Pick<ShopPhoto, 'path' | 'thumb_path'> {
  const name = `${Date.now().toString(36)}-${Array.from({ length: 12 }, () => Math.floor(random() * 36).toString(36)).join('')}`;
  return { path: `${shopId}/${name}.jpg`, thumb_path: `${shopId}/${name}-thumb.jpg` };
}

/** Base64 (from the resizer) to the bytes Storage takes. */
export function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/^data:[^,]*,/, '').replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Storage's status code for a refused file, as text ('403'), or ''. */
const statusOf = (error: unknown) => {
  const e = (error ?? {}) as { statusCode?: unknown; status?: unknown };
  return String(e.statusCode ?? e.status ?? '');
};

/** Whether Storage refused a file by its policies: not the owner's folder, or the folder full. */
export const refusedUpload = (error: unknown) => statusOf(error) === '403';

/**
 * Why a file didn't go, from Storage's answer, in words a barber can act on;
 * null for anything else (errorMessage then says it).
 */
export function uploadProblem(error: unknown): string | null {
  const code = statusOf(error);
  if (code === '413') return t('This photo is too big to send, even made smaller. Try another one.');
  if (code === '415') return t('This file isn’t a photo the app can use. Try a JPEG or PNG.');
  if (code === '403' || code === '401') return t('Only the shop’s owner can add its photos. Sign in again and retry.');
  return null;
}

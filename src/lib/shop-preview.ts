// What Find a barber already knows about a shop, handed to its page so the
// header shows at once while the services and free times load. Kept in
// memory for this visit only; a shop opened from a link loads as before.

import type { Shop } from './types.ts';

export type ShopPreview = Pick<Shop, 'slug' | 'name' | 'area' | 'address' | 'about'> & {
  rating_count: number;
  /** Average stars to one decimal; null with no reviews. */
  rating_avg: number | null;
  opens_today: string | null;
  closes_today: string | null;
  /** The shop's date those hours are for. */
  listed_on: string;
  /** How far it is with Near me on; null without it, or when the shop hasn't set its location. */
  distance_km?: number | null;
};

const previews = new Map<string, ShopPreview>();

export function rememberShop(preview: ShopPreview) {
  previews.set(preview.slug, preview);
}

export function shopPreview(slug: string | undefined): ShopPreview | null {
  return (slug && previews.get(slug)) || null;
}

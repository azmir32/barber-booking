// How far away a shop is, worked out as km_between does in
// supabase/migrations so the shop page agrees with the list, and said the
// way people say it.

export type LatLng = { latitude: number; longitude: number };

const EARTH_KM = 6371.0088;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Kilometres between two points over the earth's surface (haversine, in its atan2 form like km_between). */
export function kmBetween(a: LatLng, b: LatLng): number {
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * EARTH_KM * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/** Where a shop is, or null when its owner hasn't set it. */
export function shopPoint(shop: { latitude?: number | null; longitude?: number | null }): LatLng | null {
  return shop.latitude == null || shop.longitude == null ? null : { latitude: shop.latitude, longitude: shop.longitude };
}

/**
 * "800 m", "1.2 km", "12 km": to the nearest 100 m under a kilometre (and
 * never less than 100 m, as the position is only that close), to a tenth
 * under 10 km, then whole kilometres. Units are the same in Malay.
 */
export function distanceText(km: number): string {
  const tenths = Math.round(km * 10);
  if (tenths < 10) return `${Math.max(1, tenths) * 100} m`;
  if (tenths < 100) return `${tenths % 10 ? (tenths / 10).toFixed(1) : tenths / 10} km`;
  return `${Math.round(km)} km`;
}

/**
 * The customer's position as the app uses it: to three decimal places,
 * about 100 m, which is all a distance to the nearest 100 m needs, and
 * all the database is ever sent.
 */
export function roughly(point: LatLng): LatLng {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { latitude: round(point.latitude), longitude: round(point.longitude) };
}

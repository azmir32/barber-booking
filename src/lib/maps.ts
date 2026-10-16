import { shopPoint } from './distance.ts';

/**
 * Google Maps at the shop. Needs no API key, opens the Maps app when it is
 * installed, and on Android lets people pick Google Maps or Waze. Goes to
 * the point the owner set when there is one, since a search for the address
 * can land on the wrong row of shops; else it searches for the name and address.
 */
export function directionsUrl(shop: {
  name: string;
  address: string | null;
  area: string;
  latitude?: number | null;
  longitude?: number | null;
}): string {
  const point = shopPoint(shop);
  const query = point ? `${point.latitude},${point.longitude}` : `${shop.name}, ${shop.address || shop.area}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

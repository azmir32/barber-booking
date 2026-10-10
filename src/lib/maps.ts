/**
 * A Google Maps search for the shop. Needs no API key, opens the Maps app when
 * it is installed, and on Android lets people pick Google Maps or Waze.
 */
export function directionsUrl(shop: { name: string; address: string | null; area: string }): string {
  const query = `${shop.name}, ${shop.address || shop.area}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

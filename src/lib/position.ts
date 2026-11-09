// Whether a position from the phone is good enough for what it is for, and
// whether this page may ask for one at all. Apart from near-me.ts, which
// needs the phone, so it can be tested on its own.

/** A fix this close (in metres) finds the shop's door, not the next row of shops. */
export const SHOP_FIX_M = 50;

type PermissionDetails = {
  android?: { accuracy?: string };
  ios?: { accuracy?: string };
} | null;

/**
 * Only an approximate location was allowed ("Approximate" on Android, Precise
 * location off on iPhone): a point a kilometre or more out. Fine to sort
 * shops by, not to set one by.
 */
export const approximateOnly = (permission: PermissionDetails) =>
  permission?.android?.accuracy === 'coarse' || permission?.ios?.accuracy === 'reduced';

/** Close enough to set a shop's location by; not knowing how close (null) isn't. */
export const exactEnough = (accuracyM: number | null | undefined) =>
  accuracyM != null && accuracyM >= 0 && accuracyM <= SHOP_FIX_M;

type Policy = { allowsFeature?: (feature: string) => boolean };

/**
 * A web page framed by another site without allow="geolocation" can't have
 * location, whatever the visitor allows; the browser only says "denied".
 * Chrome and Edge can tell; other browsers can't, and this says false.
 */
export function framedWithoutLocation(doc: unknown = globalThis.document): boolean {
  const d = doc as { permissionsPolicy?: Policy; featurePolicy?: Policy } | null | undefined;
  const policy = d?.permissionsPolicy ?? d?.featurePolicy;
  try {
    return policy?.allowsFeature?.('geolocation') === false;
  } catch {
    return false;
  }
}

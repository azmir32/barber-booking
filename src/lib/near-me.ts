// Finding where the phone is, for Near me on Find a barber and for the
// shop's location on My shop. Foreground permission only: the app asks
// once, when the person taps, and never follows them around.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import { roughly, type LatLng } from '@/lib/distance';
import { approximateOnly, exactEnough, framedWithoutLocation } from '@/lib/position';

/** Near me was on when Find a barber was last left, so it opens nearest first. Only that: never the position. */
const NEAR_ME_KEY = 'potongku.nearMe';

/** Why there's no position: refused, not found, or (on the web) a page that can never have one. */
export type LocateProblem = 'denied' | 'unavailable' | 'blocked';
/** Setting the shop's location can also fail for a fix that is too rough to find its door. */
export type ShopLocateProblem = LocateProblem | 'approximate' | 'rough';
export type Located<P = LocateProblem> = { position: LatLng } | { problem: P };

/** A fix this old or newer is fine; on the web Expo would otherwise take any the browser kept. */
const FRESH_MS = 60_000;
/** Indoors a first fix can take a while; after this, the last known one will do, or none. */
const WAIT_MS = 15_000;

/** Location services were refused: by the person, the phone's settings or the browser. */
const refused = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  // 1 is the browser's PERMISSION_DENIED; the apps say ERR_LOCATION_UNAUTHORIZED
  // (Android) or ERR_DENIED_FOREGROUND_LOCATION_PERMISSION (iOS).
  return code === 1 || (typeof code === 'string' && /UNAUTHORIZED|DENIED/.test(code));
};

const failed = (e: unknown): { problem: LocateProblem } => ({ problem: refused(e) ? 'denied' : 'unavailable' });

/** Asks for the phone's location, only while the app is open; a problem, or what was allowed. */
async function ask(): Promise<{ problem: LocateProblem } | { permission: Location.LocationPermissionResponse | null }> {
  // No use asking: the browser would say denied, and no setting the visitor has would change it.
  if (framedWithoutLocation()) return { problem: 'blocked' };
  // Some browsers can't say what was allowed; asking for the position then asks the person.
  const permission = await Location.requestForegroundPermissionsAsync().catch(() => null);
  if (permission?.status === Location.PermissionStatus.DENIED) return { problem: 'denied' };
  if (!(await Location.hasServicesEnabledAsync().catch(() => true))) return { problem: 'unavailable' };
  return { permission };
}

/** One position, or null when none came in time. maximumAge is the browser's: how old a kept one may be. */
async function fixWithin(options: Location.LocationOptions & { maximumAge: number }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Location.getCurrentPositionAsync(options),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

const pointOf = (found: Location.LocationObject): LatLng => ({
  latitude: found.coords.latitude,
  longitude: found.coords.longitude,
});

/**
 * Where the phone is, for Near me: one fresh position at Balanced accuracy,
 * about 100 m, plenty to sort shops by.
 */
export async function locate(): Promise<Located> {
  try {
    const asked = await ask();
    if ('problem' in asked) return asked;
    const found =
      (await fixWithin({ accuracy: Location.Accuracy.Balanced, maximumAge: FRESH_MS })) ??
      (await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }).catch(() => null));
    if (!found) return { problem: 'unavailable' };
    return { position: pointOf(found) };
  } catch (e) {
    return failed(e);
  }
}

/**
 * Where the shop is, from the owner's phone inside it. Every customer's
 * Directions go there, so only a precise fix will do: not an approximate
 * location, not one the phone is unsure of, and never the last known one,
 * which can be the road on the way in.
 */
export async function locateShop(): Promise<Located<ShopLocateProblem>> {
  try {
    const asked = await ask();
    if ('problem' in asked) return asked;
    if (approximateOnly(asked.permission)) return { problem: 'approximate' };
    // A new fix on every tap, so trying again by the door is a new try.
    const found = await fixWithin({ accuracy: Location.Accuracy.Highest, maximumAge: 0 });
    if (!found || !exactEnough(found.coords.accuracy)) return { problem: 'rough' };
    return { position: pointOf(found) };
  } catch (e) {
    return failed(e);
  }
}

// The customer's position while Near me is on, rounded to about 100 m and
// kept in memory only, so a shop's page can say how far it is without
// asking again. Gone when Near me is turned off or the app closes.
let here: LatLng | null = null;

export const nearMePosition = () => here;

export function setNearMePosition(position: LatLng | null) {
  here = position && roughly(position);
}

export async function nearMeWasOn(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(NEAR_ME_KEY)) === 'on';
  } catch {
    return false;
  }
}

export function rememberNearMe(on: boolean) {
  (on ? AsyncStorage.setItem(NEAR_ME_KEY, 'on') : AsyncStorage.removeItem(NEAR_ME_KEY)).catch(() => {});
}

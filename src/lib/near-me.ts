// Finding where the phone is, for Near me on Find a barber and for the
// shop's location on My shop. Foreground permission only: the app asks
// once, when the person taps, and never follows them around.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import { roughly, type LatLng } from '@/lib/distance';

/** Near me was on when Find a barber was last left, so it opens nearest first. Only that: never the position. */
const NEAR_ME_KEY = 'potongku.nearMe';

export type Located = { position: LatLng } | { problem: 'denied' | 'unavailable' };

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

/**
 * Asks for the phone's location (only while the app is open) and one fresh
 * position. Balanced accuracy, about 100 m, is plenty to sort shops by;
 * the shop's own location asks for High, to find its door.
 */
export async function locate(accuracy: Location.Accuracy = Location.Accuracy.Balanced): Promise<Located> {
  try {
    // Some browsers can't say what was allowed; asking for the position then asks the person.
    const permission = await Location.requestForegroundPermissionsAsync().catch(() => null);
    if (permission?.status === Location.PermissionStatus.DENIED) return { problem: 'denied' };
    if (!(await Location.hasServicesEnabledAsync().catch(() => true))) return { problem: 'unavailable' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy, maximumAge: FRESH_MS } as Location.LocationOptions),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    const found = fix ?? (await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }).catch(() => null));
    if (!found) return { problem: 'unavailable' };
    return { position: { latitude: found.coords.latitude, longitude: found.coords.longitude } };
  } catch (e) {
    return { problem: refused(e) ? 'denied' : 'unavailable' };
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

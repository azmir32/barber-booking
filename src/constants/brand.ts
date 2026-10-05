import Constants from 'expo-constants';
import * as Linking from 'expo-linking';

// The app's name lives in app.json ("name"), so renaming is a one-line change.
export const APP_NAME = Constants.expoConfig?.name ?? 'Barber Booking';

/** Public link customers open to book with a shop. */
export function bookingLink(slug: string): string {
  const web = process.env.EXPO_PUBLIC_WEB_URL?.replace(/\/+$/, '');
  return web ? `${web}/shop/${slug}` : Linking.createURL(`/shop/${slug}`);
}

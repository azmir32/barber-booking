import Constants from 'expo-constants';
import * as Linking from 'expo-linking';

// The app's name lives in app.json ("name"), so renaming is a one-line change.
export const APP_NAME = Constants.expoConfig?.name ?? 'Barber Booking';

/**
 * The PotongKu team's WhatsApp number, where barbers ask to subscribe when
 * their free month runs out (payments are taken by hand for now, see the
 * README). Set EXPO_PUBLIC_SUPPORT_WHATSAPP before launch; without it,
 * WhatsApp opens with the message written and asks who to send it to.
 */
export const SUPPORT_WHATSAPP = process.env.EXPO_PUBLIC_SUPPORT_WHATSAPP ?? '';

/** Public link customers open to book with a shop. */
export function bookingLink(slug: string): string {
  const web = process.env.EXPO_PUBLIC_WEB_URL?.replace(/\/+$/, '');
  return web ? `${web}/shop/${slug}` : Linking.createURL(`/shop/${slug}`);
}

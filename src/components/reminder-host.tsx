import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/lib/auth';
import { onReminderTap, refreshReminders } from '@/lib/reminder-scheduler';

/**
 * Reminders' part of the app as a whole: a tapped reminder opens My bookings
 * at its booking, and coming back to the front checks the reminders against
 * the customer's bookings (at most once a minute), so one moved or cancelled
 * by the shop or on another device is right. Renders nothing.
 */
export function ReminderHost() {
  const { session, profile, loading } = useAuth();
  const pathname = usePathname();
  const customer = Boolean(session && profile?.role === 'customer');
  // The last tapped reminder's booking, and whether it has been opened (or dropped) yet.
  const [tapped, setTapped] = useState<{ booking: string; n: number } | null>(null);
  const done = useRef(0);

  useEffect(() => onReminderTap((booking) => setTapped((last) => ({ booking, n: (last?.n ?? 0) + 1 }))), []);

  useEffect(() => {
    if (!tapped || done.current === tapped.n) return;
    // Nobody to show it to: signed out (which also took the reminders away), or not a customer.
    if (!loading && !customer) {
      done.current = tapped.n;
      return;
    }
    // Waits for the start screen to send them to their tabs, so the two don't race.
    if (!customer || !(pathname.startsWith('/customer') || pathname.startsWith('/shop'))) return;
    done.current = tapped.n;
    const href = { pathname: '/customer/bookings', params: { booking: tapped.booking } } as const;
    // From a shop's page, back down to the tabs underneath rather than a second set of them on top.
    if (router.canDismiss()) router.dismissTo(href);
    else router.navigate(href);
  }, [tapped, customer, loading, pathname]);

  useEffect(() => {
    if (!customer) return;
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshReminders({ throttle: true });
    });
    return () => listener.remove();
  }, [customer]);

  return null;
}

// Keeps the reminders waiting on this phone matching the customer's
// bookings (phone-reminders.ts says which). My bookings and Find a barber
// hand it the bookings they load fresh, the booking pages and Account ask it
// to fetch them, and coming back to the front asks again, so a booking moved
// or cancelled by the shop or on another device moves or drops its
// reminders. On Android each sync also sets every reminder up again, as a
// force stop or a battery manager can drop the alarms behind them. The web
// has no reminders: reminder-scheduler.web.ts.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { t } from '@/lib/lang';
import {
  lateReminders,
  plannedReminders,
  reminderChanges,
  remindersOfKind,
  type ReminderBooking,
  type ReminderKind,
} from '@/lib/phone-reminders';
import { loadReminderPrefs, reminderState, setReminderState, type ReminderPermission } from '@/lib/reminder-settings';
import { supabase } from '@/lib/supabase';

/** False on the web, where nothing is scheduled. */
export const remindersOnThisDevice = true;

const CHANNEL = 'reminders';
/** Coming back to the front asks for the bookings at most this often. */
const RESYNC_MS = 60_000;

// A reminder that goes off while the app is open shows as it would outside it.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** The last bookings a screen loaded, and whose, so a setting changed later is applied without asking the server. */
let last: { uid: string; bookings: ReminderBooking[] } | null = null;
let lastAsked = 0;
// One change to the phone's list at a time, so two screens loading at once never schedule a reminder twice.
let queue: Promise<void> = Promise.resolve();
const inTurn = (task: () => Promise<void>) => (queue = queue.then(task).catch(() => {}));

function permissionOf(p: Notifications.NotificationPermissionsStatus): ReminderPermission {
  const ios = p.ios?.status;
  if (p.granted || ios === Notifications.IosAuthorizationStatus.PROVISIONAL || ios === Notifications.IosAuthorizationStatus.EPHEMERAL) {
    return 'granted';
  }
  return p.canAskAgain ? 'ask' : 'blocked';
}

/**
 * Android: notifications allowed, but the "Booking reminders" channel turned
 * off in the phone's Settings, which stops them all the same; said as
 * blocked, so Account says they are off and offers Settings.
 */
async function withChannel(permission: ReminderPermission): Promise<ReminderPermission> {
  if (Platform.OS !== 'android' || permission !== 'granted') return permission;
  const channel = await Notifications.getNotificationChannelAsync(CHANNEL).catch(() => null);
  return channel?.importance === Notifications.AndroidImportance.NONE ? 'blocked' : permission;
}

async function readPermission(): Promise<ReminderPermission> {
  const permission = await Notifications.getPermissionsAsync()
    .then(permissionOf)
    .then(withChannel)
    .catch((): ReminderPermission => 'unknown');
  setReminderState({ permission });
  return permission;
}

/** Android's own list of the app's kinds of notification, named in the app's language. Android 13+ only asks once one exists. */
async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: t('Booking reminders'),
    importance: Notifications.AndroidImportance.HIGH,
  });
}

const signedInAs = async () => (await supabase.auth.getSession()).data.session?.user.id ?? null;

/** Makes the phone's reminders match the last bookings, if notifications are allowed. */
async function apply() {
  await loadReminderPrefs();
  if (!last || (await readPermission()) !== 'granted') return;
  // An answer that lands after its customer signed out schedules nothing.
  if ((await signedInAs()) !== last.uid) return;
  const now = Date.now();
  const { settings } = reminderState();
  const wanted = plannedReminders(last.bookings, settings, now);
  // Ones whose time passed in the last hour stay: Android may not have shown them yet.
  const late = lateReminders(last.bookings, settings, now).map((r) => r.id);
  await ensureChannel();
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  // Android: all of them again, as its alarms can be gone while the list still has them (reminderChanges).
  const { cancel, schedule } = reminderChanges(
    wanted,
    scheduled.map((r) => r.identifier),
    { again: Platform.OS === 'android', late },
  );
  for (const id of cancel) await Notifications.cancelScheduledNotificationAsync(id);
  for (const r of schedule) {
    // One that can't be scheduled (its time passed a moment ago) shouldn't stop the rest.
    await Notifications.scheduleNotificationAsync({
      identifier: r.id,
      content: { title: r.title, body: r.body, data: { bookingId: r.bookingId } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.at, channelId: CHANNEL },
    }).catch(() => {});
  }
  setReminderState({ next: wanted[0] ?? null });
}

/** The customer's upcoming bookings, just loaded fresh by a screen: their reminders follow. */
export function syncReminders(uid: string, bookings: ReminderBooking[]): Promise<void> {
  last = { uid, bookings };
  return inTurn(apply);
}

/**
 * Asks the server for the customer's upcoming bookings and syncs, when
 * notifications are allowed: after booking or moving one, after allowing
 * notifications, and (throttled to once a minute) on coming back to the front.
 */
export async function refreshReminders(options: { throttle?: boolean } = {}): Promise<void> {
  if (options.throttle && Date.now() - lastAsked < RESYNC_MS) return;
  const uid = await signedInAs();
  if (!uid || (await readPermission()) !== 'granted') return;
  lastAsked = Date.now();
  const { data, error } = await supabase.rpc('my_upcoming_bookings');
  if (error || !Array.isArray(data)) return;
  await syncReminders(uid, data as ReminderBooking[]);
}

/** Asks again, for Account on opening and on coming back: it may have changed in the phone's settings. */
export async function checkReminderPermission(): Promise<void> {
  const was = reminderState().permission;
  const now = await readPermission();
  if (now === 'granted' && was !== 'granted') await (last ? inTurn(apply) : refreshReminders());
}

/** Shows the phone's question, once the customer has said yes in the app. */
export async function allowReminders(): Promise<ReminderPermission> {
  setReminderState({ asked: true });
  await ensureChannel().catch(() => {});
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  })
    .then(permissionOf)
    .then(withChannel)
    .catch(() => readPermission());
  setReminderState({ permission });
  if (permission === 'granted') await refreshReminders();
  return permission;
}

/** "Not now" on the booking confirmation: it doesn't ask again. */
export function notNowReminders() {
  setReminderState({ asked: true });
}

export function setReminderSetting(kind: ReminderKind, on: boolean): Promise<void> {
  setReminderState({ settings: { ...reminderState().settings, [kind]: on } });
  if (last) return inTurn(apply);
  // Nothing loaded yet this time the app is open: turning one off still takes those away.
  return inTurn(async () => {
    if (!on) {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      for (const id of remindersOfKind(kind, scheduled.map((r) => r.identifier))) {
        await Notifications.cancelScheduledNotificationAsync(id);
      }
    }
  }).then(() => (on ? refreshReminders() : undefined));
}

/** Signing out or deleting the account: nothing of theirs stays waiting, or in the phone's list. */
export function cancelAllReminders(): Promise<void> {
  last = null;
  lastAsked = 0;
  setReminderState({ next: null });
  return inTurn(async () => {
    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.dismissAllNotificationsAsync();
  });
}

const handled = new Set<string>();

/**
 * Calls `open` with the booking of a reminder the customer tapped: one that
 * opened the app from closed, then each tap while it runs.
 */
export function onReminderTap(open: (bookingId: string) => void): () => void {
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const { identifier, content } = response.notification.request;
    const bookingId = content.data?.bookingId;
    // Both ways can hear of the tap that opened the app.
    const key = `${identifier}|${response.notification.date}`;
    if (typeof bookingId !== 'string' || handled.has(key)) return;
    handled.add(key);
    // Taken, so the app opening again (or a change of language) doesn't open it a second time.
    Notifications.clearLastNotificationResponse();
    open(bookingId);
  };
  handle(Notifications.getLastNotificationResponse());
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  return () => subscription.remove();
}

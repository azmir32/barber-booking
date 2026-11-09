// The web has no reminders of its own: a page can't wake a closed browser,
// and the booking's Add to calendar does that job here. The setting still
// shows, and is kept, so the demo looks like the app (reminder-scheduler.ts).

import type { ReminderBooking, ReminderKind } from '@/lib/phone-reminders';
import { reminderState, setReminderState, type ReminderPermission } from '@/lib/reminder-settings';

export const remindersOnThisDevice = false;

setReminderState({ permission: 'unsupported' });

export async function syncReminders(_uid: string, _bookings: ReminderBooking[]): Promise<void> {}

export async function refreshReminders(_options: { throttle?: boolean } = {}): Promise<void> {}

export async function checkReminderPermission(): Promise<void> {}

export async function allowReminders(): Promise<ReminderPermission> {
  return 'unsupported';
}

export function notNowReminders() {
  setReminderState({ asked: true });
}

export async function setReminderSetting(kind: ReminderKind, on: boolean): Promise<void> {
  setReminderState({ settings: { ...reminderState().settings, [kind]: on } });
}

export async function cancelAllReminders(): Promise<void> {}

export function onReminderTap(_open: (bookingId: string) => void): () => void {
  return () => {};
}

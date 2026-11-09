// The customer's reminder settings on this phone, and what the phone lets
// the app do, in one place for Account, the booking confirmation and the
// scheduler: allowing notifications on one shows on the others at once.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import { DEFAULT_REMINDER_SETTINGS, parseReminderPrefs, type PlannedReminder, type ReminderSettings } from '@/lib/phone-reminders';

/**
 * Whether the phone shows the app's notifications: not known yet, allowed,
 * not allowed but the app may ask, or turned off in the phone's settings
 * (asking again shows nothing). The web has no reminders at all.
 */
export type ReminderPermission = 'unknown' | 'granted' | 'ask' | 'blocked' | 'unsupported';

export type ReminderState = {
  settings: ReminderSettings;
  /** The booking confirmation asks once, on this phone, and never again. */
  asked: boolean;
  permission: ReminderPermission;
  /** The soonest reminder waiting on the phone, as of the last sync. */
  next: PlannedReminder | null;
};

const KEY = 'potongku.reminders';

let state: ReminderState = { settings: DEFAULT_REMINDER_SETTINGS, asked: false, permission: 'unknown', next: null };
const listeners = new Set<() => void>();
let loaded: Promise<void> | null = null;

export function reminderState(): ReminderState {
  return state;
}

export function setReminderState(patch: Partial<ReminderState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
  if (patch.settings || patch.asked !== undefined) {
    AsyncStorage.setItem(KEY, JSON.stringify({ ...state.settings, asked: state.asked })).catch(() => {});
  }
}

/** Reads the settings kept on the phone, once. */
export function loadReminderPrefs(): Promise<void> {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      const { settings, asked } = parseReminderPrefs(raw);
      state = { ...state, settings, asked };
      for (const listener of listeners) listener();
    })
    .catch(() => {});
  return loaded;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReminderState(): ReminderState {
  useEffect(() => {
    loadReminderPrefs();
  }, []);
  return useSyncExternalStore(subscribe, reminderState, reminderState);
}

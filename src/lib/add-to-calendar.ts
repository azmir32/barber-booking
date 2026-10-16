// Adds a booking to the customer's calendar from the app, through Google
// Calendar's add-event link: Android opens it in the Calendar app, iOS in the
// browser. expo-calendar's add-event sheet on iOS would ask for calendar
// access first, and needs a development build instead of Expo Go. The web
// has its own version in add-to-calendar.web.ts.

import { Linking } from 'react-native';

import { googleCalendarUrl, type CalendarEvent } from './calendar';

export async function addToCalendar(event: CalendarEvent): Promise<void> {
  await Linking.openURL(googleCalendarUrl(event));
}

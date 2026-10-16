// On the web, Safari on an iPhone, iPad or Mac opens a downloaded .ics file
// in Apple's Calendar; other browsers get Google Calendar in a new tab.

import { Linking } from 'react-native';

import { APP_NAME } from '@/constants/brand';

import { googleCalendarUrl, icsFile, icsFileName, opensIcsFiles, type CalendarEvent } from './calendar';

/** Safari reads the file after the click returns, so the link to it is kept a while. */
const KEEP_FILE = 60_000;

export async function addToCalendar(event: CalendarEvent): Promise<void> {
  // A page in a frame, like the demo inside another site, is often not allowed
  // to download, and the button would seem to do nothing.
  if (opensIcsFiles(navigator.userAgent) && window.self === window.top) {
    download(icsFile(event, APP_NAME), icsFileName(event));
    return;
  }
  await Linking.openURL(googleCalendarUrl(event));
}

function download(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), KEEP_FILE);
}

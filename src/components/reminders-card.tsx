import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, StyleSheet } from 'react-native';

import { Button, Card, Row, SwitchRow, T } from '@/components/ui';
import { APP_NAME } from '@/constants/brand';
import { useNow } from '@/hooks/use-now';
import { t } from '@/lib/lang';
import { whenLabel } from '@/lib/my-shops';
import { plannedReminders, remindersLine, type ReminderBooking } from '@/lib/phone-reminders';
import {
  allowReminders,
  checkReminderPermission,
  notNowReminders,
  remindersOnThisDevice,
  setReminderSetting,
} from '@/lib/reminder-scheduler';
import { useReminderState, type ReminderPermission } from '@/lib/reminder-settings';
import { useBigText } from '@/lib/text-size-provider';

/** Notifications refused: said plainly, with the phone's Settings a tap away (under it with big text, rather than squeezing it). */
function RefusedLine({ text }: { text: string }) {
  const big = useBigText();
  return (
    <Row style={big ? undefined : styles.noWrap}>
      <T variant="small" role="alert" accessibilityLiveRegion="polite" style={big ? styles.wholeLine : styles.grow}>
        {text}
      </T>
      <Button title={t('Settings')} variant="ghost" onPress={() => Linking.openSettings()} />
    </Row>
  );
}

/**
 * Account's reminders: the evening before and an hour before, each on or
 * off, on this phone. While the phone hasn't been asked it offers to allow
 * notifications; refused, it says so with a way to Settings. On the web the
 * setting shows with where reminders come instead.
 */
export function RemindersCard() {
  const { settings, permission, next } = useReminderState();
  const now = useNow();
  const [asking, setAsking] = useState(false);
  // Asked again on opening and on coming back to the app: it may have been changed in the phone's settings.
  useFocusEffect(
    useCallback(() => {
      checkReminderPermission();
    }, []),
  );
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkReminderPermission();
    });
    return () => listener.remove();
  }, []);
  // Nothing to allow with both off.
  const anyOn = settings.evening || settings.hour;

  async function allow() {
    setAsking(true);
    await allowReminders();
    setAsking(false);
  }

  return (
    <Card>
      <T variant="heading">{t('Reminders')}</T>
      <SwitchRow
        label={t('Evening before')}
        detail={t('At 8 pm the day before')}
        value={settings.evening}
        onChange={(on) => setReminderSetting('evening', on)}
      />
      <SwitchRow label={t('An hour before')} value={settings.hour} onChange={(on) => setReminderSetting('hour', on)} />
      {!remindersOnThisDevice ? (
        <T variant="small">
          {t('Reminders come in the {app} app on your phone. Here, add a booking to your calendar to be reminded.', {
            app: APP_NAME,
          })}
        </T>
      ) : (
        <>
          <T variant="small">{t('They come on this phone only.')}</T>
          {anyOn && permission === 'ask' ? (
            <>
              <T variant="small">{t('Allow notifications so they can show.')}</T>
              <Button title={t('Allow notifications')} variant="secondary" loading={asking} onPress={allow} />
            </>
          ) : null}
          {anyOn && permission === 'blocked' ? (
            <RefusedLine
              text={t('Notifications are off for {app}, so reminders can’t show. Turn them on in Settings.', { app: APP_NAME })}
            />
          ) : null}
          {anyOn && permission === 'granted' && next && next.at > now ? (
            <T variant="small">
              {t('Next reminder: {when}, for {service} at {shop}.', {
                when: whenLabel(new Date(next.at).toISOString(), now, next.timeZone),
                service: next.service,
                shop: next.title,
              })}
            </T>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * Under a booking just made: which reminders will come for it, or once on
 * this phone (the first booking), whether to have them, with a line saying
 * why before the phone's own question. On the web, its calendar does it.
 */
export function BookedReminders({ booking }: { booking: ReminderBooking }) {
  const { settings, permission, asked } = useReminderState();
  const now = useNow();
  const [asking, setAsking] = useState(false);
  // What the phone said when asked from here, to say so if it was no.
  const [answer, setAnswer] = useState<ReminderPermission | null>(null);
  useEffect(() => {
    checkReminderPermission();
  }, []);

  if (!remindersOnThisDevice) {
    return (
      <T variant="small" style={styles.center}>
        {t('Your calendar can remind you before it.')}
      </T>
    );
  }
  // Both turned off in Account, or too soon for either: nothing to offer.
  const line = remindersLine(plannedReminders([booking], settings, now).map((r) => r.kind));
  if (!line) return null;
  if (permission === 'granted') {
    return (
      <T variant="small" style={styles.center}>
        {line}
      </T>
    );
  }
  // In the card that asked, so it stays where they tapped and lines up with the cards below.
  if (answer === 'ask' || answer === 'blocked') {
    return (
      <Card style={styles.prompt}>
        <RefusedLine text={t('Notifications are off, so no reminders will come. You can turn them on in Settings.')} />
      </Card>
    );
  }
  // Kept while the phone asks (allowReminders marks it asked at once), so the button shows it is busy
  // and the page doesn't jump behind the phone's question.
  if (!asking && (permission !== 'ask' || asked)) return null;

  async function turnOn() {
    setAsking(true);
    setAnswer(await allowReminders());
    setAsking(false);
  }

  return (
    <Card style={styles.prompt}>
      <T variant="heading">{t('Get a reminder so you don’t miss it?')}</T>
      <T variant="small">{line}</T>
      <Row>
        <Button title={t('Turn on reminders')} loading={asking} onPress={turnOn} />
        <Button title={t('Not now')} variant="ghost" onPress={notNowReminders} />
      </Row>
    </Card>
  );
}

const styles = StyleSheet.create({
  noWrap: { flexWrap: 'nowrap' },
  grow: { flex: 1 },
  wholeLine: { flexBasis: '100%' },
  center: { textAlign: 'center' },
  // Inside the centred confirmation, as wide as the cards below it.
  prompt: { alignSelf: 'stretch' },
});

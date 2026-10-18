import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { Badge, Button, Card, Empty, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { barberAbout, BARBER_ABOUT_MAX_LENGTH } from '@/lib/barbers';
import { confirmAction } from '@/lib/confirm';
import { summarizeWeek } from '@/lib/hours';
import { t } from '@/lib/lang';
import { addBarber, useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { localDateString } from '@/lib/time';
import type { Barber, WorkingHours } from '@/lib/types';

type BarberWithHours = Barber & { working_hours: WorkingHours[] };

/** Customers still booked with a barber who is away: how many, and the first one. */
type StillBooked = Record<string, { count: number; first: string }>;

export default function Team() {
  const { shop } = useMyShop();
  const [barbers, setBarbers] = useState<BarberWithHours[]>([]);
  // Until the team has loaded once, "No barbers yet" might just be a bad signal, so nothing is offered.
  const [loaded, setLoaded] = useState(false);
  const [stillBooked, setStillBooked] = useState<StillBooked>({});
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Said next to the Add barber button, where it was tapped.
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shop) return;
    const { data, error } = await supabase
      .from('barbers')
      .select('*, working_hours(*)')
      .eq('shop_id', shop.id)
      .order('sort_order')
      .order('created_at');
    if (error) return setError(errorMessage(error));
    const team = (data ?? []) as BarberWithHours[];
    setBarbers(team);
    setLoaded(true);
    setError(null);
    const away = team.filter((b) => !b.is_active).map((b) => b.id);
    if (away.length === 0) return setStillBooked({});
    const upcoming = await supabase
      .from('bookings')
      .select('barber_id, starts_at')
      .in('barber_id', away)
      .eq('status', 'confirmed')
      .eq('is_block', false)
      .gte('starts_at', new Date().toISOString())
      .order('starts_at');
    if (upcoming.error) return;
    const byBarber: StillBooked = {};
    for (const b of (upcoming.data ?? []) as { barber_id: string; starts_at: string }[]) {
      const seen = byBarber[b.barber_id];
      byBarber[b.barber_id] = seen ? { ...seen, count: seen.count + 1 } : { count: 1, first: b.starts_at };
    }
    setStillBooked(byBarber);
  }, [shop]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function add() {
    if (!shop || !name.trim()) return;
    setBusy(true);
    const { error } = await addBarber(shop.id, name, barbers.length);
    setBusy(false);
    if (error) return setAddError(errorMessage(error));
    setName('');
    setAddError(null);
    load();
  }

  /** Away only stops new bookings, so first say how many are still in that barber's diary. */
  async function okToMarkAway(b: Barber): Promise<boolean> {
    const { count, error } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('barber_id', b.id)
      .eq('status', 'confirmed')
      .eq('is_block', false)
      .gte('starts_at', new Date().toISOString());
    if (error) {
      setError(errorMessage(error));
      return false;
    }
    if (!count) return true;
    return confirmAction(
      t('Mark {name} away?', { name: b.name }),
      count === 1
        ? t('{name} has 1 upcoming booking. Away only stops new bookings, so it stays booked until you cancel it.', {
            name: b.name,
          })
        : t(
            '{name} has {count} upcoming bookings. Away only stops new bookings, so they stay booked until you cancel them.',
            { name: b.name, count },
          ),
      t('Mark away'),
      t('Not now'),
    );
  }

  async function toggle(b: Barber) {
    setToggling(b.id);
    if (b.is_active && !(await okToMarkAway(b))) return setToggling(null);
    const { error } = await supabase.from('barbers').update({ is_active: !b.is_active }).eq('id', b.id);
    setToggling(null);
    if (error) return setError(errorMessage(error));
    load();
  }

  /** For a barber added by mistake. One with bookings stays, so past bookings keep their barber. */
  async function remove(b: Barber) {
    const ok = await confirmAction(
      t('Remove {name}?', { name: b.name }),
      t('They will no longer show anywhere in the app.'),
      t('Remove barber'),
    );
    if (!ok) return;
    const { error } = await supabase.from('barbers').delete().eq('id', b.id);
    if (error?.code === '23503') {
      return setError(t('{name} has bookings, so stays on the team as away. Past bookings keep their barber.', { name: b.name }));
    }
    if (error) return setError(errorMessage(error));
    setError(null);
    load();
  }

  /** The Bookings tab, on the first day this barber still has customers, showing only theirs. */
  function seeBookings(b: Barber) {
    const first = stillBooked[b.id]?.first;
    if (!shop || !first) return;
    router.navigate({
      pathname: '/barber',
      params: { day: localDateString(new Date(first), shop.time_zone), barber: b.id, at: String(Date.now()) },
    });
  }

  return (
    <Screen>
      <T variant="title">{t('Barbers')}</T>
      <T variant="muted">{t('One per chair. Customers can pick a barber or take whoever is free.')}</T>

      <Section title={t('Your team')}>
        {!loaded ? (
          error ? (
            <>
              <ErrorText message={`${t('Couldn’t load your team.')} ${error}`} />
              <Button title={t('Try again')} variant="secondary" onPress={load} />
            </>
          ) : null
        ) : barbers.length === 0 ? (
          <Empty title={t('No barbers yet')} body={t('Add yourself and anyone who cuts in your shop.')} />
        ) : null}
        {barbers.map((b) => {
          const booked = b.is_active ? undefined : stillBooked[b.id];
          return (
            <Card key={b.id}>
              <Row style={{ gap: Spacing.sm }}>
                <T variant="label">{b.name}</T>
                {b.is_active ? null : <Badge label={t('Away')} tone="warning" />}
              </Row>
              <BarberIntro barber={b} onSaved={(about) => setBarbers((team) => team.map((x) => (x.id === b.id ? { ...x, about } : x)))} />
              <T variant="small">{b.is_active ? summarizeWeek(b.working_hours) : t('Away, not taking bookings')}</T>
              {booked ? (
                <T variant="small">
                  {booked.count === 1
                    ? t('1 customer is still booked with {name}.', { name: b.name })
                    : t('{count} customers are still booked with {name}.', { count: booked.count, name: b.name })}
                </T>
              ) : null}
              <Row>
                {b.is_active ? (
                  <>
                    <Button
                      title={t('Hours')}
                      variant="secondary"
                      onPress={() => router.push({ pathname: '/barber/hours/[id]', params: { id: b.id } })}
                    />
                    <Button title={t('Mark away')} variant="ghost" loading={toggling === b.id} onPress={() => toggle(b)} />
                  </>
                ) : (
                  // Back at work is the usual next step; their bookings, or removing a mistake, come after.
                  <>
                    <Button
                      title={t('Back at work')}
                      variant="secondary"
                      loading={toggling === b.id}
                      onPress={() => toggle(b)}
                    />
                    {booked ? (
                      <Button
                        title={t('See bookings')}
                        accessibilityLabel={t('See {name}’s bookings', { name: b.name })}
                        variant="secondary"
                        onPress={() => seeBookings(b)}
                      />
                    ) : null}
                    <Button
                      title={t('Hours')}
                      variant="ghost"
                      onPress={() => router.push({ pathname: '/barber/hours/[id]', params: { id: b.id } })}
                    />
                    {booked ? null : (
                      <Button
                        title={t('Remove barber')}
                        accessibilityLabel={t('Remove {name}', { name: b.name })}
                        variant="ghost"
                        tone="danger"
                        onPress={() => remove(b)}
                      />
                    )}
                  </>
                )}
              </Row>
            </Card>
          );
        })}
        {loaded ? <ErrorText message={error} /> : null}
      </Section>

      {loaded ? (
        <Section title={t('Add a barber')}>
          <View style={{ gap: Spacing.sm }}>
            <Field
              label={t('Name')}
              value={name}
              onChangeText={setName}
              placeholder={t('e.g. Danial')}
              onSubmitEditing={add}
              maxLength={40}
            />
            <T variant="small">{t('New barbers start with 10am–8pm, Monday to Saturday. Tap Hours to change.')}</T>
          </View>
          <ErrorText message={addError} />
          <Button title={t('Add barber')} onPress={add} loading={busy} disabled={!name.trim()} />
        </Section>
      ) : null}
    </Screen>
  );
}

/**
 * The line customers see under a barber's name when they pick one, e.g.
 * "Skin fades and beard trims, 8 years": shown here with Edit, or "+ Add an
 * intro", opening a box for it right in the card.
 */
function BarberIntro({ barber, onSaved }: { barber: Barber; onSaved: (about: string | null) => void }) {
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { name, about } = barber;

  // Blank takes it away. Done on the keyboard goes by the Save button's rule:
  // with nothing there to take away, it just closes the box.
  async function save(typed: string) {
    const line = barberAbout(typed);
    if (saving) return;
    if (!line && !about) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    const { error } = await supabase.from('barbers').update({ about: line }).eq('id', barber.id);
    setSaving(false);
    if (error) return setError(errorMessage(error));
    onSaved(line);
    setEditing(false);
    setDone(line ? t('Intro saved.') : t('Intro removed.'));
  }

  if (editing) {
    return (
      <View style={{ gap: Spacing.sm }}>
        <Field
          label={t('{name}’s intro', { name })}
          hint={t('Customers see it under the name when they pick a barber. One line, up to 60 characters.')}
          value={text}
          onChangeText={setText}
          placeholder={t('e.g. Skin fades and beard trims, 8 years')}
          maxLength={BARBER_ABOUT_MAX_LENGTH}
          onSubmitEditing={() => save(text)}
          autoFocus
        />
        <ErrorText message={error} />
        <Row style={{ flexWrap: 'nowrap' }}>
          <Button
            title={t('Cancel')}
            variant="secondary"
            onPress={() => {
              setEditing(false);
              setError(null);
            }}
          />
          <Button
            title={t('Save intro')}
            onPress={() => save(text)}
            loading={saving}
            disabled={!barberAbout(text) && !about}
            style={{ flex: 1 }}
          />
        </Row>
        {about ? <Button title={t('Remove intro')} variant="ghost" tone="danger" onPress={() => save('')} /> : null}
      </View>
    );
  }

  const open = () => {
    setText(about ?? '');
    setDone(null);
    setEditing(true);
  };
  return (
    <View style={{ gap: Spacing.xs }}>
      {about ? (
        <Row style={{ flexWrap: 'nowrap' }}>
          <T variant="muted" style={{ flex: 1 }}>
            {about}
          </T>
          <Button
            title={t('Edit')}
            variant="ghost"
            accessibilityLabel={t('Edit {name}’s intro', { name })}
            onPress={open}
            style={{ paddingHorizontal: Spacing.md }}
          />
        </Row>
      ) : (
        <Button
          title={t('+ Add an intro')}
          variant="ghost"
          accessibilityLabel={t('Add an intro for {name}', { name })}
          onPress={open}
          style={{ alignSelf: 'flex-start', paddingHorizontal: 0 }}
        />
      )}
      {done ? (
        <T variant="small" role="status" accessibilityLiveRegion="polite" style={{ color: theme.success }}>
          {done}
        </T>
      ) : null}
    </View>
  );
}

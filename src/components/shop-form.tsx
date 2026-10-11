import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, useState } from 'react';
import { Linking, Platform, View, type TextInput } from 'react-native';

import { Button, Chip, ErrorText, Field, Row, T } from '@/components/ui';
import { APP_NAME, bookingLink } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { shopPoint, type LatLng } from '@/lib/distance';
import { t } from '@/lib/lang';
import { directionsUrl } from '@/lib/maps';
import { addBarber } from '@/lib/my-shop';
import { locateShop, type ShopLocateProblem } from '@/lib/near-me';
import { errorMessage, supabase } from '@/lib/supabase';
import { slugify, suggestSlug } from '@/lib/time';
import type { Shop } from '@/lib/types';

/** Another shop has this booking link (shops_slug_key); only the link has to be unique. */
const slugTaken = (error: { code?: string; message?: string }) =>
  error.code === '23505' && /slug/.test(error.message ?? '');

type Details = Pick<
  Shop,
  'name' | 'slug' | 'about' | 'address' | 'area' | 'latitude' | 'longitude' | 'phone' | 'instagram'
>;

/** The details as they are saved, so what was typed and what is stored compare like for like. */
const clean = (d: Details) => ({
  name: d.name.trim(),
  slug: slugify(d.slug),
  about: d.about?.trim() || null,
  address: d.address?.trim() || null,
  area: d.area.trim() || 'Kajang',
  latitude: d.latitude ?? null,
  longitude: d.longitude ?? null,
  phone: d.phone?.trim() || null,
  instagram: d.instagram?.trim().replace(/^@/, '') || null,
});

/** To six decimal places, about 10 cm: as close as any phone can tell, and no closer. */
const sixPlaces = (n: number) => Math.round(n * 1e6) / 1e6;

/** Creates the barber's shop, or edits it when `shop` is given. */
export function ShopForm({ shop, onSaved }: { shop?: Shop | null; onSaved: () => void }) {
  const theme = useTheme();
  const { session, profile } = useAuth();
  const [name, setName] = useState(shop?.name ?? '');
  const [slug, setSlug] = useState(shop?.slug ?? '');
  const [slugEdited, setSlugEdited] = useState(Boolean(shop));
  // Once customers have the link, changing it breaks every copy already
  // shared, so a shop that has been live (even if paused now) has to ask for it first.
  const [slugUnlocked, setSlugUnlocked] = useState(false);
  const slugLocked = Boolean(shop?.is_published || shop?.published_at) && !slugUnlocked;
  const [about, setAbout] = useState(shop?.about ?? '');
  const [address, setAddress] = useState(shop?.address ?? '');
  const [area, setArea] = useState(shop?.area ?? 'Kajang');
  const [phone, setPhone] = useState(shop?.phone ?? profile?.phone ?? '');
  const [instagram, setInstagram] = useState(shop?.instagram ?? '');
  // Where the shop is, from the owner's phone while they stand in it.
  const [point, setPoint] = useState<LatLng | null>(shop ? shopPoint(shop) : null);
  const [locating, setLocating] = useState(false);
  const [placeProblem, setPlaceProblem] = useState<ShopLocateProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The link another shop turned out to have, said at the link field with one to try instead.
  const [taken, setTaken] = useState<string | null>(null);
  // The details as last saved, so "Saved." only shows until the next edit.
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const slugField = useRef<TextInput>(null);

  const fields = clean({
    name,
    slug,
    about,
    address,
    area,
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    phone,
    instagram,
  });
  const cleanSlug = fields.slug;
  const current = JSON.stringify(fields);
  const justSaved = savedAs === current;
  // Nothing to save: the shop as it is, or as just saved while it reloads.
  const unchanged = shop != null && (justSaved || current === JSON.stringify(clean(shop)));
  const takenNow = taken != null && taken === cleanSlug;
  const suggestion = takenNow ? suggestSlug(cleanSlug, area) : null;

  // Saved as it is shown: the location, set or removed, waits for Save changes like every other field.
  const pointUnsaved = shop != null && !justSaved && JSON.stringify(point) !== JSON.stringify(shopPoint(shop));

  async function setPointHere() {
    setLocating(true);
    setPlaceProblem(null);
    const found = await locateShop();
    setLocating(false);
    if ('problem' in found) return setPlaceProblem(found.problem);
    setPoint({ latitude: sixPlaces(found.position.latitude), longitude: sixPlaces(found.position.longitude) });
  }

  async function unlockSlug() {
    const ok = await confirmAction(
      t('Change your booking link?'),
      t('Links you already shared, in your Instagram bio, WhatsApp status or posters, will stop working.'),
      t('Change link'),
    );
    if (ok) setSlugUnlocked(true);
  }

  function failed(e: { code?: string; message?: string }) {
    setBusy(false);
    if (slugTaken(e)) {
      setTaken(cleanSlug);
      // Brings the link field, and what it says, into view.
      slugField.current?.focus();
      return;
    }
    setError(errorMessage(e));
  }

  async function save() {
    if (!session) return;
    setBusy(true);
    setError(null);
    if (shop) {
      const { error } = await supabase.from('shops').update(fields).eq('id', shop.id);
      if (error) return failed(error);
      setBusy(false);
      setSavedAs(current);
      setSlugUnlocked(false);
      return onSaved();
    }
    const { data, error } = await supabase
      .from('shops')
      .insert({ ...fields, owner_id: session.user.id })
      .select()
      .single();
    if (error) return failed(error);
    // Most shops start with the owner cutting, so give them the first chair.
    await addBarber(data.id, profile?.full_name || t('Me'));
    setBusy(false);
    onSaved();
  }

  return (
    <>
      <Field
        label={t('Shop name')}
        value={name}
        onChangeText={(v) => {
          setName(v);
          if (!slugEdited) setSlug(slugify(v));
        }}
        placeholder={t('e.g. Kemas Barber Kajang')}
        maxLength={80}
      />
      {slugLocked ? (
        <View style={{ gap: Spacing.xs }}>
          <T variant="label">{t('Booking link')}</T>
          {/* On a line of its own: a long link and a button side by side ran off a narrow phone. */}
          <T selectable>{bookingLink(cleanSlug)}</T>
          <Button title={t('Change link')} variant="secondary" onPress={unlockSlug} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : (
        <View style={{ gap: Spacing.sm }}>
          <Field
            ref={slugField}
            label={t('Booking link')}
            value={slug}
            onChangeText={(v) => {
              setSlugEdited(true);
              setSlug(v);
            }}
            autoCapitalize="none"
            autoFocus={slugUnlocked}
            maxLength={40}
            error={takenNow ? t('“{link}” is taken by another shop. Try another link.', { link: cleanSlug }) : null}
            hint={cleanSlug ? bookingLink(cleanSlug) : t('Letters, numbers and dashes.')}
          />
          {suggestion ? (
            <Row>
              <Chip
                label={t('Use {link}', { link: suggestion })}
                onPress={() => {
                  setSlugEdited(true);
                  setSlug(suggestion);
                }}
              />
            </Row>
          ) : null}
        </View>
      )}
      <Field
        label={t('About')}
        value={about}
        onChangeText={setAbout}
        multiline
        placeholder={t('Fades, beard trims, kids cuts…')}
        maxLength={500}
      />
      <Field
        label={t('Address')}
        value={address}
        onChangeText={setAddress}
        // Room for a whole Kajang address, so it can be checked as customers will see it.
        multiline
        placeholder={t('Street, taman and postcode')}
        maxLength={200}
      />
      <Field label={t('Area')} value={area} onChangeText={setArea} maxLength={60} />
      <View role="group" accessibilityLabel={t('Shop location')} style={{ gap: Spacing.sm }}>
        <T variant="label">{t('Shop location')}</T>
        {point ? (
          <>
            <Row style={{ flexWrap: 'nowrap', gap: Spacing.xs }}>
              <Ionicons name="checkmark-circle" size={20} color={theme.success} />
              <T style={{ flex: 1 }}>{t('Location set')}</T>
            </Row>
            <Row>
              <Button
                title={t('Check on the map')}
                variant="secondary"
                icon="map-outline"
                onPress={() => Linking.openURL(directionsUrl({ name, address, area, ...point }))}
              />
              <Button
                title={t('Remove')}
                variant="ghost"
                tone="danger"
                accessibilityLabel={t('Remove the shop location')}
                onPress={() => {
                  setPoint(null);
                  setPlaceProblem(null);
                }}
              />
            </Row>
          </>
        ) : (
          <>
            <T variant="small">
              {t(
                'Optional. Tap this while you’re in the shop, so customers nearby find you first and Directions bring them to your door.',
              )}
            </T>
            <Button
              title={t('Use my location here')}
              variant="secondary"
              icon="locate-outline"
              loading={locating}
              onPress={setPointHere}
              style={{ alignSelf: 'flex-start' }}
            />
          </>
        )}
        {placeProblem ? (
          <Row style={{ flexWrap: 'nowrap' }}>
            <View style={{ flex: 1 }}>
              <ErrorText message={placeProblemText(placeProblem)} />
            </View>
            {(placeProblem === 'denied' || placeProblem === 'approximate') && Platform.OS !== 'web' ? (
              <Button title={t('Settings')} variant="ghost" onPress={() => Linking.openSettings()} />
            ) : null}
          </Row>
        ) : pointUnsaved ? (
          <T variant="small" role="status" accessibilityLiveRegion="polite">
            {t('Not saved yet. Tap Save changes below.')}
          </T>
        ) : null}
      </View>
      <Field
        label={t('Shop phone (WhatsApp)')}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        maxLength={20}
      />
      <Field
        label="Instagram"
        value={instagram}
        onChangeText={setInstagram}
        autoCapitalize="none"
        placeholder={t('@yourshop')}
        maxLength={60}
      />
      <ErrorText message={error} />
      <Button
        title={shop ? t('Save changes') : t('Create my shop')}
        onPress={save}
        loading={busy}
        disabled={!name.trim() || !cleanSlug || unchanged}
      />
      {shop && justSaved ? (
        <T variant="small" role="status" accessibilityLiveRegion="polite">
          {t('Saved.')}
        </T>
      ) : null}
    </>
  );
}

/** Why "Use my location here" didn't set it, and what to do about it. */
function placeProblemText(problem: ShopLocateProblem) {
  switch (problem) {
    case 'approximate':
      return t('{app} only has your approximate location. Turn on Precise location in Settings, then try again.', {
        app: APP_NAME,
      });
    case 'rough':
      return t('Couldn’t get your exact spot. Try again near the door or just outside.');
    case 'blocked':
      return t('Location isn’t available on this page. Customers can still find you by your address.');
    case 'unavailable':
      return t('Couldn’t find where you are. Check that location is on, then try again.');
    case 'denied':
      return Platform.OS === 'web'
        ? t('Your browser is blocking location. Allow it for this site, then try again.')
        : t('Location is off for {app}. Allow it in Settings, then try again.', { app: APP_NAME });
  }
}

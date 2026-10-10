import { useRef, useState } from 'react';
import { View, type TextInput } from 'react-native';

import { Button, Chip, ErrorText, Field, Row, T } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { addBarber } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { slugify, suggestSlug } from '@/lib/time';
import type { Shop } from '@/lib/types';

/** Another shop has this booking link (shops_slug_key); only the link has to be unique. */
const slugTaken = (error: { code?: string; message?: string }) =>
  error.code === '23505' && /slug/.test(error.message ?? '');

type Details = Pick<Shop, 'name' | 'slug' | 'about' | 'address' | 'area' | 'phone' | 'instagram'>;

/** The details as they are saved, so what was typed and what is stored compare like for like. */
const clean = (d: Details) => ({
  name: d.name.trim(),
  slug: slugify(d.slug),
  about: d.about?.trim() || null,
  address: d.address?.trim() || null,
  area: d.area.trim() || 'Kajang',
  phone: d.phone?.trim() || null,
  instagram: d.instagram?.trim().replace(/^@/, '') || null,
});

/** Creates the barber's shop, or edits it when `shop` is given. */
export function ShopForm({ shop, onSaved }: { shop?: Shop | null; onSaved: () => void }) {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The link another shop turned out to have, said at the link field with one to try instead.
  const [taken, setTaken] = useState<string | null>(null);
  // The details as last saved, so "Saved." only shows until the next edit.
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const slugField = useRef<TextInput>(null);

  const fields = clean({ name, slug, about, address, area, phone, instagram });
  const cleanSlug = fields.slug;
  const current = JSON.stringify(fields);
  const justSaved = savedAs === current;
  // Nothing to save: the shop as it is, or as just saved while it reloads.
  const unchanged = shop != null && (justSaved || current === JSON.stringify(clean(shop)));
  const takenNow = taken != null && taken === cleanSlug;
  const suggestion = takenNow ? suggestSlug(cleanSlug, area) : null;

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

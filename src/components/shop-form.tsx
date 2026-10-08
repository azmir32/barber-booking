import { useState } from 'react';
import { View } from 'react-native';

import { Button, ErrorText, Field, Row, T } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { addBarber } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { slugify } from '@/lib/time';
import type { Shop } from '@/lib/types';

/** Creates the barber's shop, or edits it when `shop` is given. */
export function ShopForm({ shop, onSaved }: { shop?: Shop | null; onSaved: () => void }) {
  const { session, profile } = useAuth();
  const [name, setName] = useState(shop?.name ?? '');
  const [slug, setSlug] = useState(shop?.slug ?? '');
  const [slugEdited, setSlugEdited] = useState(Boolean(shop));
  // Once customers have the link, changing it breaks every copy already
  // shared, so a live shop has to ask for it first.
  const [slugUnlocked, setSlugUnlocked] = useState(false);
  const slugLocked = Boolean(shop?.is_published) && !slugUnlocked;
  const [about, setAbout] = useState(shop?.about ?? '');
  const [address, setAddress] = useState(shop?.address ?? '');
  const [area, setArea] = useState(shop?.area ?? 'Kajang');
  const [phone, setPhone] = useState(shop?.phone ?? profile?.phone ?? '');
  const [instagram, setInstagram] = useState(shop?.instagram ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanSlug = slugify(slug);

  async function unlockSlug() {
    const ok = await confirmAction(
      t('Change your booking link?'),
      t('Links you already shared, in your Instagram bio, WhatsApp status or posters, will stop working.'),
      t('Change link'),
    );
    if (ok) setSlugUnlocked(true);
  }

  async function save() {
    if (!session) return;
    setBusy(true);
    setError(null);
    const fields = {
      name: name.trim(),
      slug: cleanSlug,
      about: about.trim() || null,
      address: address.trim() || null,
      area: area.trim() || 'Kajang',
      phone: phone.trim() || null,
      instagram: instagram.trim().replace(/^@/, '') || null,
    };
    if (shop) {
      const { error } = await supabase.from('shops').update(fields).eq('id', shop.id);
      setBusy(false);
      if (error) return setError(errorMessage(error));
      setSlugUnlocked(false);
      return onSaved();
    }
    const { data, error } = await supabase
      .from('shops')
      .insert({ ...fields, owner_id: session.user.id })
      .select()
      .single();
    if (error) {
      setBusy(false);
      return setError(errorMessage(error));
    }
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
          <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
            <T selectable style={{ flex: 1 }}>
              {bookingLink(cleanSlug)}
            </T>
            <Button title={t('Change link')} variant="ghost" onPress={unlockSlug} />
          </Row>
        </View>
      ) : (
        <Field
          label={t('Booking link')}
          value={slug}
          onChangeText={(v) => {
            setSlugEdited(true);
            setSlug(v);
          }}
          autoCapitalize="none"
          autoFocus={slugUnlocked}
          maxLength={40}
          hint={cleanSlug ? bookingLink(cleanSlug) : t('Letters, numbers and dashes.')}
        />
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
        placeholder="No. 12, Jalan Reko, Kajang"
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
        disabled={!name.trim() || !cleanSlug}
      />
    </>
  );
}

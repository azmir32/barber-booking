import { useState } from 'react';

import { Button, ErrorText, Field } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
import { useAuth } from '@/lib/auth';
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
  const [about, setAbout] = useState(shop?.about ?? '');
  const [address, setAddress] = useState(shop?.address ?? '');
  const [area, setArea] = useState(shop?.area ?? 'Kajang');
  const [phone, setPhone] = useState(shop?.phone ?? profile?.phone ?? '');
  const [instagram, setInstagram] = useState(shop?.instagram ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanSlug = slugify(slug);

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
    await addBarber(data.id, profile?.full_name || 'Me');
    setBusy(false);
    onSaved();
  }

  return (
    <>
      <Field
        label="Shop name"
        value={name}
        onChangeText={(v) => {
          setName(v);
          if (!slugEdited) setSlug(slugify(v));
        }}
        placeholder="e.g. Kemas Barber Kajang"
      />
      <Field
        label="Booking link"
        value={slug}
        onChangeText={(v) => {
          setSlugEdited(true);
          setSlug(v);
        }}
        autoCapitalize="none"
        hint={cleanSlug ? bookingLink(cleanSlug) : 'Letters, numbers and dashes.'}
      />
      <Field label="About" value={about} onChangeText={setAbout} multiline placeholder="Fades, beard trims, kids cuts…" />
      <Field label="Address" value={address} onChangeText={setAddress} placeholder="No. 12, Jalan Reko, Kajang" />
      <Field label="Area" value={area} onChangeText={setArea} />
      <Field label="Shop phone (WhatsApp)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Field label="Instagram" value={instagram} onChangeText={setInstagram} autoCapitalize="none" placeholder="@yourshop" />
      <ErrorText message={error} />
      <Button
        title={shop ? 'Save changes' : 'Create my shop'}
        onPress={save}
        loading={busy}
        disabled={!name.trim() || !cleanSlug}
      />
    </>
  );
}

import { router } from 'expo-router';
import { useState } from 'react';

import { DemoSwitch } from '@/components/demo-panel';
import { Button, Card, Chip, ErrorText, Field, Row, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { useLanguage } from '@/lib/i18n';
import { LANGUAGES, t } from '@/lib/lang';
import { demo, errorMessage, supabase } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

/** Language, name, phone, sign out and delete account. Shared by the customer and barber apps. */
export function AccountPanel() {
  const { session, profile } = useAuth();
  return (
    <>
      {!session || !profile ? (
        <Card>
          <T variant="muted">{t('You’re browsing as a guest.')}</T>
          <Button title={t('Sign in')} onPress={() => router.push('/sign-in')} />
          <Button title={t('Create an account')} variant="secondary" onPress={() => router.push('/sign-up')} />
        </Card>
      ) : (
        <>
          {demo ? (
            <Card>
              <T variant="label">{t('Demo')}</T>
              <DemoSwitch role={profile.role} />
            </Card>
          ) : null}
          <AccountForm key={profile.id} email={session.user.email ?? ''} profile={profile} />
        </>
      )}
      <LanguagePicker />
    </>
  );
}

function LanguagePicker() {
  const { lang, setLang } = useLanguage();
  return (
    <Card>
      <T variant="label">{t('Language')}</T>
      <Row role="radiogroup" accessibilityLabel={t('Language')}>
        {LANGUAGES.map((l) => (
          <Chip key={l.code} label={l.name} selected={lang === l.code} onPress={() => setLang(l.code)} />
        ))}
      </Row>
    </Card>
  );
}

function AccountForm({ email, profile }: { email: string; profile: Profile }) {
  const { refreshProfile, signOut } = useAuth();
  const [fullName, setFullName] = useState(profile.full_name);
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Field errors show once Save is pressed, then clear as soon as the field is fixed.
  const [checked, setChecked] = useState(false);

  const changed = fullName.trim() !== profile.full_name || (phone.trim() || null) !== (profile.phone ?? null);
  // The barber recognises and reaches a customer by these; a barber's shop has its own number.
  const nameError = checked && !fullName.trim() ? t('Enter your name') : null;
  const phoneError =
    checked && profile.role === 'customer' && !phone.trim()
      ? t('Enter a WhatsApp number so your barber can reach you')
      : null;

  // Any edit makes "Saved." untrue until Save is pressed again.
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setSaved(false);
  };

  async function save() {
    setChecked(true);
    if (!fullName.trim() || (profile.role === 'customer' && !phone.trim())) return;
    setBusy(true);
    setSaved(false);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: fullName.trim(), phone: phone.trim() || null })
      .eq('id', profile.id);
    setBusy(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    setSaved(true);
    refreshProfile();
  }

  async function deleteAccount() {
    const ok = await confirmAction(
      t('Delete your account?'),
      profile.role === 'barber'
        ? t(
            'This deletes your shop, booking link, services and all its bookings. Let customers with upcoming bookings know first. This can’t be undone.',
          )
        : t('Your upcoming bookings will be cancelled. This can’t be undone.'),
      t('Delete account'),
    );
    if (!ok) return;
    setBusy(true);
    const { error } = await supabase.rpc('delete_my_account');
    setBusy(false);
    if (error) return setError(errorMessage(error));
    await signOut();
    router.replace('/welcome');
  }

  return (
    <Card>
      <T variant="muted">{email}</T>
      <Field
        label={t('Full name')}
        value={fullName}
        onChangeText={edit(setFullName)}
        maxLength={80}
        autoComplete="name"
        error={nameError}
      />
      <Field
        label={t('Phone (WhatsApp)')}
        value={phone}
        onChangeText={edit(setPhone)}
        keyboardType="phone-pad"
        autoComplete="tel"
        maxLength={20}
        error={phoneError}
      />
      <ErrorText message={error} />
      {saved ? <T variant="small">{t('Saved.')}</T> : null}
      {/* Nothing to save until something has changed. */}
      <Button title={t('Save')} variant="secondary" onPress={save} loading={busy} disabled={!changed} />
      <Button
        title={t('Sign out')}
        variant="ghost"
        onPress={async () => {
          await signOut();
          router.replace('/welcome');
        }}
      />
      <Button
        title={t('Delete account')}
        variant="ghost"
        tone="danger"
        onPress={deleteAccount}
        disabled={busy}
        style={{ marginTop: Spacing.lg }}
      />
    </Card>
  );
}

import { router } from 'expo-router';
import { useState } from 'react';

import { DemoSwitch } from '@/components/demo-panel';
import { Button, Card, Chip, ErrorText, Field, Row, T } from '@/components/ui';
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
      <Row>
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

  async function save() {
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
      <Field label={t('Full name')} value={fullName} onChangeText={setFullName} maxLength={80} />
      <Field label={t('Phone (WhatsApp)')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={20} />
      <ErrorText message={error} />
      {saved ? <T variant="small">{t('Saved.')}</T> : null}
      <Button title={t('Save')} variant="secondary" onPress={save} loading={busy} />
      <Button
        title={t('Sign out')}
        variant="ghost"
        onPress={async () => {
          await signOut();
          router.replace('/welcome');
        }}
      />
      <Button title={t('Delete account')} variant="ghost" onPress={deleteAccount} disabled={busy} />
    </Card>
  );
}

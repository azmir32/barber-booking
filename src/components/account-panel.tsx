import { router } from 'expo-router';
import { useState } from 'react';

import { Button, Card, ErrorText, Field, T } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { errorMessage, supabase } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

/** Name, phone, sign out and delete account. Shared by the customer and barber apps. */
export function AccountPanel() {
  const { session, profile } = useAuth();
  if (!session || !profile) {
    return (
      <Card>
        <T variant="muted">{"You're browsing as a guest."}</T>
        <Button title="Sign in" onPress={() => router.push('/sign-in')} />
        <Button title="Create an account" variant="secondary" onPress={() => router.push('/sign-up')} />
      </Card>
    );
  }
  return <AccountForm key={profile.id} email={session.user.email ?? ''} profile={profile} />;
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
      'Delete your account?',
      profile.role === 'barber'
        ? 'This deletes your shop, booking link, services and all its bookings. Let customers with upcoming bookings know first. This can’t be undone.'
        : 'Your upcoming bookings will be cancelled. This can’t be undone.',
      'Delete account',
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
      <Field label="Full name" value={fullName} onChangeText={setFullName} maxLength={80} />
      <Field label="Phone (WhatsApp)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={20} />
      <ErrorText message={error} />
      {saved ? <T variant="small">Saved.</T> : null}
      <Button title="Save" variant="secondary" onPress={save} loading={busy} />
      <Button
        title="Sign out"
        variant="ghost"
        onPress={async () => {
          await signOut();
          router.replace('/welcome');
        }}
      />
      <Button title="Delete account" variant="ghost" onPress={deleteAccount} disabled={busy} />
    </Card>
  );
}

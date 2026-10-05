import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, ErrorText, Field, Row, Screen, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { returnAfterAuth } from '@/lib/navigation';
import { errorMessage, supabase } from '@/lib/supabase';
import type { Role } from '@/lib/types';

export default function SignUp() {
  const params = useLocalSearchParams<{ role?: string; next?: string }>();
  const [role, setRole] = useState<Role>(params.role === 'barber' ? 'barber' : 'customer');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);

  const canSubmit = fullName.trim() && phone.trim() && email.trim() && password.length >= 8;

  async function submit() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { role, full_name: fullName.trim(), phone: phone.trim() } },
    });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    // With email confirmation on, there is no session until they click the link.
    if (!data.session) return setCheckEmail(true);
    returnAfterAuth(params.next);
  }

  if (checkEmail) {
    return (
      <Screen edges={[]}>
        <T variant="heading">Check your email</T>
        <T variant="muted">
          We sent a confirmation link to {email.trim()}. Tap it, then come back and sign in.
        </T>
        <Button title="Go to sign in" onPress={() => router.replace('/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <View style={{ gap: Spacing.sm }}>
        <T variant="label">I am a</T>
        <Row>
          <Chip label="Customer" selected={role === 'customer'} onPress={() => setRole('customer')} />
          <Chip label="Barber / shop owner" selected={role === 'barber'} onPress={() => setRole('barber')} />
        </Row>
        {role === 'barber' ? (
          <T variant="small">Your first month is free. You can set up your shop right after this.</T>
        ) : null}
      </View>
      <Field label="Full name" value={fullName} onChangeText={setFullName} autoComplete="name" maxLength={80} />
      <Field
        label="Phone (WhatsApp)"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoComplete="tel"
        maxLength={20}
        placeholder="012-345 6789"
        hint={role === 'barber' ? 'Customers will see this to contact you.' : 'Your barber can reach you here if plans change.'}
      />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        hint="At least 8 characters."
      />
      <ErrorText message={error} />
      <Button title="Create account" onPress={submit} loading={busy} disabled={!canSubmit} />
    </Screen>
  );
}

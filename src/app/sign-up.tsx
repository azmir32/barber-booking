import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Button, Card, Chip, ErrorText, Field, Row, Screen, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { t } from '@/lib/lang';
import { returnAfterAuth } from '@/lib/navigation';
import { errorMessage, supabase } from '@/lib/supabase';
import type { Role } from '@/lib/types';

export default function SignUp() {
  const params = useLocalSearchParams<{ role?: string; next?: string; summary?: string }>();
  // Sent here from a shop page with a time picked, so this is a customer finishing a booking.
  const booking = params.summary;
  const [role, setRole] = useState<Role>(params.role === 'barber' && !booking ? 'barber' : 'customer');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);

  const canSubmit = fullName.trim() && phone.trim() && email.trim() && password.length >= 8;

  // Carries the way back to the shop, and the booking, over to sign in.
  const goToSignIn = () =>
    router.replace({
      pathname: '/sign-in',
      params: { ...(params.next ? { next: params.next } : {}), ...(booking ? { summary: booking } : {}) },
    });

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
        <T variant="heading">{t('Check your email')}</T>
        <T variant="muted">
          {t('We sent a confirmation link to {email}. Tap it, then come back and sign in.', { email: email.trim() })}
        </T>
        {booking ? (
          <BookingSummary
            summary={booking}
            note={t('Not booked yet. Once your email is confirmed, sign in to finish booking.')}
          />
        ) : null}
        <Button title={t('Go to sign in')} onPress={goToSignIn} />
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      {booking ? (
        <BookingSummary summary={booking} note={t('Create an account to finish booking.')}>
          <Button title={t('Already have an account? Sign in')} variant="secondary" onPress={goToSignIn} />
        </BookingSummary>
      ) : (
        <View style={{ gap: Spacing.sm }}>
          <T variant="label">{t('I am a')}</T>
          <Row>
            <Chip label={t('Customer')} selected={role === 'customer'} onPress={() => setRole('customer')} />
            <Chip label={t('Barber / shop owner')} selected={role === 'barber'} onPress={() => setRole('barber')} />
          </Row>
          {role === 'barber' ? (
            <T variant="small">{t('Your first month is free. You can set up your shop right after this.')}</T>
          ) : null}
        </View>
      )}
      <Field label={t('Full name')} value={fullName} onChangeText={setFullName} autoComplete="name" maxLength={80} />
      <Field
        label={t('Phone (WhatsApp)')}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoComplete="tel"
        maxLength={20}
        placeholder="012-345 6789"
        hint={
          role === 'barber'
            ? t('Customers will see this to contact you.')
            : t('Your barber can reach you here if plans change.')
        }
      />
      <Field
        label={t('Email')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
      />
      <Field
        label={t('Password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        hint={t('At least 8 characters.')}
      />
      <ErrorText message={error} />
      <Button title={t('Create account')} onPress={submit} loading={busy} disabled={!canSubmit} />
      {booking ? null : <Button title={t('Already have an account? Sign in')} variant="ghost" onPress={goToSignIn} />}
    </Screen>
  );
}

/** The service and time picked on the shop page, so a new customer can see it is not lost. */
function BookingSummary({ summary, note, children }: { summary: string; note: string; children?: ReactNode }) {
  return (
    <Card>
      <T variant="label">{t('Your booking')}</T>
      <T variant="heading">{summary}</T>
      <T variant="muted">{note}</T>
      {children}
    </Card>
  );
}

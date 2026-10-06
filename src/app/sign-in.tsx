import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Button, ErrorText, Field, Screen, T } from '@/components/ui';
import { t } from '@/lib/lang';
import { returnAfterAuth } from '@/lib/navigation';
import { demo, errorMessage, supabase } from '@/lib/supabase';

export default function SignIn() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    returnAfterAuth(next);
  }

  return (
    <Screen edges={[]}>
      <Field
        label={t('Email')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        placeholder="you@email.com"
      />
      <Field
        label={t('Password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        onSubmitEditing={submit}
      />
      <ErrorText message={error} />
      {demo ? (
        <T variant="small" selectable>
          {t('Demo accounts: {customer} (customer) or {barber} (barber). Password: {password}', {
            customer: demo.DEMO_CUSTOMER_EMAIL,
            barber: demo.DEMO_BARBER_EMAIL,
            password: demo.DEMO_PASSWORD,
          })}
        </T>
      ) : null}
      <Button title={t('Sign in')} onPress={submit} loading={busy} disabled={!email || !password} />
      <Button
        title={t('Forgot password?')}
        variant="ghost"
        onPress={() =>
          router.replace({
            pathname: '/forgot-password',
            params: { ...(email.trim() ? { email: email.trim() } : {}), ...(next ? { next } : {}) },
          })
        }
      />
      <T variant="muted" style={{ textAlign: 'center' }}>
        {t('New here?')}
      </T>
      <Button
        title={t('Create an account')}
        variant="secondary"
        onPress={() => router.replace({ pathname: '/sign-up', params: next ? { next } : {} })}
      />
    </Screen>
  );
}

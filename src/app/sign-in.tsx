import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useState } from 'react';

import { Button, ErrorText, Field, Screen, T } from '@/components/ui';
import { errorMessage, supabase } from '@/lib/supabase';

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
    router.replace((next || '/') as Href);
  }

  return (
    <Screen edges={[]}>
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        placeholder="you@email.com"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        onSubmitEditing={submit}
      />
      <ErrorText message={error} />
      <Button title="Sign in" onPress={submit} loading={busy} disabled={!email || !password} />
      <T variant="muted" style={{ textAlign: 'center' }}>
        New here?
      </T>
      <Button
        title="Create an account"
        variant="secondary"
        onPress={() => router.replace({ pathname: '/sign-up', params: next ? { next } : {} })}
      />
    </Screen>
  );
}

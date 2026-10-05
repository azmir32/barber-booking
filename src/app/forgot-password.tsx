import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Button, ErrorText, Field, Screen, T } from '@/components/ui';
import { returnAfterAuth } from '@/lib/navigation';
import { errorMessage, supabase } from '@/lib/supabase';

/**
 * Reset by emailed code rather than link, so it works the same in the app
 * and on the web, and when the email is opened on another device.
 * The Supabase "Reset password" email template must include {{ .Token }}.
 */
export default function ForgotPassword() {
  const params = useLocalSearchParams<{ email?: string; next?: string }>();
  const [email, setEmail] = useState(params.email ?? '');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    const address = email.trim();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(address);
    setBusy(false);
    if (error) return setError(errorMessage(error));
    setSentTo(address);
  }

  async function reset() {
    if (!sentTo) return;
    setBusy(true);
    setError(null);
    const verified = await supabase.auth.verifyOtp({ email: sentTo, token: code.trim(), type: 'recovery' });
    if (verified.error) {
      setBusy(false);
      return setError('That code is wrong or has expired. Check the latest email, or send a new code.');
    }
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    returnAfterAuth(params.next);
  }

  if (!sentTo) {
    return (
      <Screen edges={[]}>
        <T variant="muted">Enter the email you signed up with and we&apos;ll send you a code to set a new password.</T>
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@email.com"
          onSubmitEditing={sendCode}
        />
        <ErrorText message={error} />
        <Button title="Send code" onPress={sendCode} loading={busy} disabled={!email.trim()} />
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <T variant="muted">
        If {sentTo} has an account, a code is on its way. It can take a minute; check your spam folder too.
      </T>
      <Field
        label="Code from the email"
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        placeholder="123456"
        maxLength={10}
      />
      <Field
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        hint="At least 8 characters."
        onSubmitEditing={reset}
      />
      <ErrorText message={error} />
      <Button
        title="Set new password"
        onPress={reset}
        loading={busy}
        disabled={code.trim().length < 6 || password.length < 8}
      />
      <Button title="Send a new code" variant="ghost" onPress={sendCode} disabled={busy} />
      <Button title="Use a different email" variant="ghost" onPress={() => setSentTo(null)} disabled={busy} />
    </Screen>
  );
}


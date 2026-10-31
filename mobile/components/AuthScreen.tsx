import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { colors, radii, spacing, type } from '../theme';
import { GlassCard, GlassScreen, PrimaryButton, TextLink } from './ui';

export default function AuthScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(mode: 'signIn' | 'signUp') {
    if (password.length < 6) {
      setError('Password needs 6+ characters.');
      return;
    }
    setBusy(true);
    setError(null);
    const credentials = { email: email.trim(), password };
    const { error: authError } =
      mode === 'signIn'
        ? await supabase.auth.signInWithPassword(credentials)
        : await supabase.auth.signUp(credentials);
    setBusy(false);
    // App.tsx switches screens when the session changes.
    if (authError) {
      setError(mode === 'signIn' ? 'Wrong email or password.' : "Couldn't create account.");
    }
  }

  return (
    <GlassScreen>
      <View style={styles.container}>
        <Text style={styles.title}>What to eat!</Text>
        <GlassCard>
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.textSecondary}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.textSecondary}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            textContentType="password"
          />
          {error && <Text style={styles.error}>{error}</Text>}
          {busy ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <>
              <PrimaryButton label="Sign in" onPress={() => submit('signIn')} />
              <View style={styles.center}>
                <TextLink label="Create account" onPress={() => submit('signUp')} />
              </View>
            </>
          )}
        </GlassCard>
      </View>
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.lg,
  },
  title: {
    fontSize: type.title,
    fontWeight: '700',
    textAlign: 'center',
    color: colors.text,
  },
  input: {
    backgroundColor: colors.glassStrong,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    fontSize: type.body,
    color: colors.text,
  },
  error: {
    color: colors.error,
    textAlign: 'center',
  },
  spinner: {
    marginVertical: 14,
  },
  center: {
    alignItems: 'center',
  },
});

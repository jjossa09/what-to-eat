import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';

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
    <View style={styles.container}>
      <Text style={styles.title}>What to eat!</Text>
      <TextInput
        style={styles.input}
        placeholder="Email"
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
          <Pressable style={styles.button} onPress={() => submit('signIn')}>
            <Text style={styles.buttonText}>Sign in</Text>
          </Pressable>
          <Pressable style={styles.link} onPress={() => submit('signUp')}>
            <Text style={styles.linkText}>Create account</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
  },
  error: {
    color: '#c0392b',
    textAlign: 'center',
  },
  spinner: {
    marginVertical: 14,
  },
  button: {
    backgroundColor: '#111',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  link: {
    padding: 8,
    alignItems: 'center',
  },
  linkText: {
    fontSize: 15,
    color: '#333',
  },
});

import type { Session } from '@supabase/supabase-js';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AuthScreen from './components/AuthScreen';
import Quiz from './components/Quiz';
import { GlassScreen, PrimaryButton } from './components/ui';
import { hasTasteProfile } from './lib/profile';
import { supabase } from './lib/supabase';

// After sign-in: the taste quiz once (no taste profile yet), then home.
type Gate = 'checking' | 'quiz' | 'home' | 'error';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // The gate belongs to one user; a different user starts at 'checking' again.
  const [gateState, setGateState] = useState<{ userId: string; gate: Gate } | null>(null);
  const userId = session?.user.id ?? null;
  const gate: Gate = gateState && gateState.userId === userId ? gateState.gate : 'checking';

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const fetchGate = useCallback((id: string, isLive: () => boolean = () => true) => {
    const set = (next: Gate) => isLive() && setGateState({ userId: id, gate: next });
    hasTasteProfile(id)
      .then((exists) => set(exists ? 'home' : 'quiz'))
      .catch(() => set('error'));
  }, []);

  // Once per signed-in user, not on every token refresh.
  useEffect(() => {
    if (!userId) return;
    let live = true;
    fetchGate(userId, () => live);
    return () => {
      live = false;
    };
  }, [userId, fetchGate]);

  function retryGate() {
    if (!userId) return;
    setGateState({ userId, gate: 'checking' });
    fetchGate(userId);
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) {
    return (
      <>
        <AuthScreen />
        <StatusBar style="auto" />
      </>
    );
  }

  if (gate === 'quiz') {
    return (
      <>
        <Quiz onDone={() => userId && setGateState({ userId, gate: 'home' })} />
        <StatusBar style="dark" />
      </>
    );
  }

  if (gate === 'checking' || gate === 'error') {
    return (
      <GlassScreen>
        <View style={styles.gate}>
          {gate === 'checking' ? (
            <ActivityIndicator />
          ) : (
            <>
              <Text style={styles.gateText}>Couldn&apos;t load.</Text>
              <PrimaryButton label="Retry" onPress={retryGate} />
            </>
          )}
        </View>
        <StatusBar style="dark" />
      </GlassScreen>
    );
  }

  return (
    <View style={styles.container}>
      <Text>What to eat!</Text>
      <Pressable style={styles.signOut} onPress={() => supabase.auth.signOut()}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gate: {
    flex: 1,
    justifyContent: 'center',
    gap: 16,
  },
  gateText: {
    fontSize: 15,
    color: '#6b6b76',
    textAlign: 'center',
  },
  signOut: {
    position: 'absolute',
    bottom: 48,
    padding: 8,
  },
  signOutText: {
    color: '#666',
  },
});

import Ionicons from '@expo/vector-icons/Ionicons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import type { Session } from '@supabase/supabase-js';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import { type ComponentProps, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import AuthScreen from './components/AuthScreen';
import Chat from './components/Chat';
import DockBackground from './components/Dock';
import PressScale from './components/PressScale';
import NameStep from './components/NameStep';
import Quiz from './components/Quiz';
import { GlassScreen, PrimaryButton, useDockBottom, useTabBarSpace } from './components/ui';
import { hasTasteProfile, loadDisplayName } from './lib/profile';
import { supabase } from './lib/supabase';
import MapScreen from './screens/MapScreen';
import MealsScreen from './screens/MealsScreen';
import ProfileScreen from './screens/ProfileScreen';
import { colors, dock, radii, spacing, type } from './theme';

// After sign-in: the taste quiz once, then the name once, then the tabs (P1-22).
type Gate = 'checking' | 'quiz' | 'name' | 'home' | 'error';

type Tabs = { Eat: undefined; Map: undefined; Meals: undefined; Profile: undefined };
const Tab = createBottomTabNavigator<Tabs>();

type IconName = ComponentProps<typeof Ionicons>['name'];
const TAB_ICONS: Record<keyof Tabs, IconName> = {
  Eat: 'restaurant',
  Map: 'map',
  Meals: 'receipt',
  Profile: 'person',
};

const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.gradient[0], primary: colors.accent },
};

const signOut = () => {
  supabase.auth.signOut();
};

function EatTab({ userId }: { userId: string }) {
  const space = useTabBarSpace();
  return <Chat userId={userId} onSignOut={signOut} bottom={space} />;
}

function HomeTabs({ userId }: { userId: string }) {
  const dockBottom = useDockBottom();
  return (
    <NavigationContainer theme={navTheme}>
      <Tab.Navigator
        // The capsule floats above the safe area itself, so the bar adds no inset padding.
        safeAreaInsets={{ bottom: 0, left: 0, right: 0 }}
        // A light tap when switching tabs (not when re-tapping the current one).
        screenListeners={({ navigation }) => ({
          tabPress: () => {
            if (!navigation.isFocused()) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
            }
          },
        })}
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: [styles.dock, { bottom: dockBottom }],
          tabBarItemStyle: styles.dockItem,
          tabBarLabelStyle: styles.dockLabel,
          tabBarBackground: () => <DockBackground />,
          tabBarButton: ({ ref: _ref, ...props }) => <PressScale {...props} />,
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={(focused ? TAB_ICONS[route.name] : `${TAB_ICONS[route.name]}-outline`) as IconName}
              color={color}
              size={dock.iconSize}
            />
          ),
        })}
      >
        <Tab.Screen name="Eat">{() => <EatTab userId={userId} />}</Tab.Screen>
        <Tab.Screen name="Map" component={MapScreen} />
        <Tab.Screen name="Meals">{() => <MealsScreen userId={userId} />}</Tab.Screen>
        <Tab.Screen name="Profile">
          {() => <ProfileScreen userId={userId} onSignOut={signOut} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}

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
    Promise.all([hasTasteProfile(id), loadDisplayName(id)])
      .then(([hasProfile, name]) => set(!hasProfile ? 'quiz' : name ? 'home' : 'name'))
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

  let screen;
  if (loading) {
    screen = (
      <GlassScreen>
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      </GlassScreen>
    );
  } else if (!session || !userId) {
    screen = <AuthScreen />;
  } else if (gate === 'quiz') {
    // Right after the quiz, the name is asked if it is not set yet.
    screen = <Quiz onDone={() => fetchGate(userId)} />;
  } else if (gate === 'name') {
    screen = <NameStep onDone={() => setGateState({ userId, gate: 'home' })} />;
  } else if (gate === 'home') {
    screen = <HomeTabs userId={userId} />;
  } else {
    screen = (
      <GlassScreen>
        <View style={styles.center}>
          {gate === 'checking' ? (
            <ActivityIndicator />
          ) : (
            <>
              <Text style={styles.gateText}>Couldn&apos;t load.</Text>
              <PrimaryButton label="Retry" onPress={retryGate} />
            </>
          )}
        </View>
      </GlassScreen>
    );
  }

  return (
    <SafeAreaProvider>
      {screen}
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.lg,
  },
  gateText: {
    fontSize: type.small,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  dock: {
    position: 'absolute',
    // The navigator's base style pins the bar with start: 0 and end: 0, and start/end win
    // over left/right in React Native, so the side inset must use start/end too.
    start: dock.sideInset,
    end: dock.sideInset,
    height: dock.height,
    borderRadius: radii.pill,
    borderTopWidth: 0,
    backgroundColor: colors.transparent,
    paddingTop: 0,
    paddingBottom: 0,
    elevation: 0,
    shadowColor: colors.shadow,
    shadowOpacity: dock.shadowOpacity,
    shadowRadius: dock.shadowRadius,
    shadowOffset: { width: 0, height: 8 },
  },
  dockItem: {
    paddingVertical: spacing.sm,
  },
  dockLabel: {
    fontSize: dock.labelSize,
    fontWeight: '600',
  },
});

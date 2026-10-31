import { type NavigationProp, type ParamListBase, useFocusEffect, useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Attribution, EmojiPin } from '../components/PlaceMap';
import PressScale from '../components/PressScale';
import { Chip, GlassCard, GlassScreen, PrimaryButton, useTabBarSpace } from '../components/ui';
import type { Place } from '../lib/api';
import { getPosition, type Position } from '../lib/location';
import { directionsUrl, nearbyPlaces } from '../lib/places';
import { loadCategories } from '../lib/profile';
import { colors, emojiFor, map, radii, spacing, type } from '../theme';

// Map tab (P1-13): Apple Map centered on the user with nearby places as emoji pins. One search
// when the tab opens, reused until the user moves about 500 m.

type Problem = 'denied' | 'nofix' | 'places';

const PROBLEM_TEXT: Record<Problem, string> = {
  denied: 'Location is off.',
  nofix: "Couldn't find you.",
  places: "Couldn't load places.",
};

const METERS_PER_MILE = 1609.344;

function miles(meters: number): string {
  return `${Math.max(0.1, meters / METERS_PER_MILE).toFixed(1)} mi`;
}

export default function MapScreen() {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const insets = useSafeAreaInsets();
  const space = useTabBarSpace();
  const [user, setUser] = useState<Position | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    loadCategories()
      .then((rows) => setNames(new Map(rows.map((c) => [c.id, c.name]))))
      .catch(() => undefined); // the card falls back to the category id
  }, []);

  const load = useCallback(async (isLive: () => boolean = () => true) => {
    const where = await getPosition();
    if (!isLive()) return;
    if (!where.ok) {
      setProblem(where.reason === 'denied' ? 'denied' : 'nofix');
      return;
    }
    setUser((prev) => prev ?? where.position);
    try {
      const found = await nearbyPlaces(where.position);
      if (!isLive()) return;
      setPlaces(found);
      setProblem(null);
    } catch {
      if (isLive()) setProblem('places');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      load(() => live);
      return () => {
        live = false;
      };
    }, [load]),
  );

  function retry() {
    setProblem(null);
    load();
  }

  if (!user) {
    return (
      <GlassScreen tabBar>
        <View style={[styles.center, { paddingBottom: space }]}>
          {problem ? (
            <GlassCard>
              <Text style={styles.problemText}>{PROBLEM_TEXT[problem]}</Text>
              <View style={styles.row}>
                {problem === 'denied' && <Chip label="Open Settings" onPress={() => Linking.openSettings()} />}
                <Chip label="Try again" onPress={retry} />
              </View>
            </GlassCard>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      </GlassScreen>
    );
  }

  return (
    <View style={styles.screen}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={{
          latitude: user.lat,
          longitude: user.lon,
          latitudeDelta: map.startDelta,
          longitudeDelta: map.startDelta,
        }}
        showsUserLocation
        onPress={(e) => {
          // A pin tap also reaches the map on iOS; only a tap on the map itself closes the card.
          if (e.nativeEvent.action !== 'marker-press') setSelected(null);
        }}
      >
        {places.map((p) => (
          <Marker
            key={`${p.id}-${p.id === selected?.id}`}
            coordinate={{ latitude: p.lat, longitude: p.lon }}
            tracksViewChanges={false}
            onPress={() => setSelected(p)}
          >
            <EmojiPin category={p.category} selected={p.id === selected?.id} />
          </Marker>
        ))}
      </MapView>

      <View style={[styles.top, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
        <View style={styles.pill}>
          <Attribution />
        </View>
        {problem && (
          <View style={styles.pill}>
            <Text style={styles.problemText}>{PROBLEM_TEXT[problem]}</Text>
            <Chip label="Try again" onPress={retry} />
          </View>
        )}
      </View>

      <View style={[styles.bottom, { bottom: space }]} pointerEvents="box-none">
        {selected && (
          <GlassCard>
            <View style={styles.cardTop}>
              <Text style={styles.emoji}>{emojiFor(selected.category)}</Text>
              <View style={styles.cardText}>
                <Text style={styles.name} numberOfLines={1}>
                  {selected.name}
                </Text>
                <Text style={styles.meta}>
                  {`${names.get(selected.category) ?? selected.category} · ${miles(selected.distance_m)}`}
                </Text>
              </View>
            </View>
            <PrimaryButton
              label="Directions"
              onPress={() => Linking.openURL(directionsUrl(selected.lat, selected.lon))}
            />
          </GlassCard>
        )}
        <PressScale
          style={styles.fab}
          onPress={() => navigation.navigate('Eat')}
          accessibilityRole="button"
        >
          <Text style={styles.fabText}>What to eat?</Text>
        </PressScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  top: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  problemText: {
    fontSize: type.small,
    color: colors.error,
  },
  bottom: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    gap: spacing.md,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  emoji: {
    fontSize: 28,
  },
  cardText: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: type.body,
    fontWeight: '600',
    color: colors.text,
  },
  meta: {
    fontSize: type.small,
    color: colors.textSecondary,
  },
  fab: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    shadowColor: colors.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  fabText: {
    fontSize: type.body,
    fontWeight: '600',
    color: colors.text,
  },
});

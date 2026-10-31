import { useRef } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import type { Position } from '../lib/location';
import { colors, emojiFor, map, spacing, type } from '../theme';

// Shared map pieces (P1-13): emoji pins, the chat's mini map, and the results attribution.
// Default provider: Apple Maps on iOS (react-native-maps, included in Expo Go).

export const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';

export type MapPlace = { id: string; name: string; lat: number; lon: number; category: string };

export function EmojiPin({ category, selected = false }: { category: string; selected?: boolean }) {
  return (
    <View style={[styles.pin, selected && styles.pinSelected]}>
      <Text style={styles.pinEmoji}>{emojiFor(category)}</Text>
    </View>
  );
}

/** "Powered by Geoapify · © OpenStreetMap contributors" (NFR5), the OSM part linked. */
export function Attribution({ style }: { style?: object }) {
  return (
    <Text style={[styles.attribution, style]}>
      Powered by Geoapify ·{' '}
      <Text style={styles.link} onPress={() => Linking.openURL(OSM_COPYRIGHT)}>
        © OpenStreetMap contributors
      </Text>
    </Text>
  );
}

type MiniMapProps = {
  places: MapPlace[];
  user: Position | null;
  selectedId: string | null;
};

/** The chat's small, non-interactive map with the 3 picks (and the user), zoomed to fit. */
export function MiniMap({ places, user, selectedId }: MiniMapProps) {
  const ref = useRef<MapView>(null);
  const coords = [
    ...places.map((p) => ({ latitude: p.lat, longitude: p.lon })),
    ...(user ? [{ latitude: user.lat, longitude: user.lon }] : []),
  ];
  const first = coords[0];

  return (
    <View style={styles.mini}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        initialRegion={
          first && {
            latitude: first.latitude,
            longitude: first.longitude,
            latitudeDelta: map.startDelta,
            longitudeDelta: map.startDelta,
          }
        }
        onMapReady={() => {
          const pad = map.fitPadding;
          ref.current?.fitToCoordinates(coords, {
            edgePadding: { top: pad, right: pad, bottom: pad, left: pad },
            animated: false,
          });
        }}
        showsUserLocation={user !== null}
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
      >
        {places.map((p) => (
          <Marker
            key={`${p.id}-${p.id === selectedId}`}
            coordinate={{ latitude: p.lat, longitude: p.lon }}
            tracksViewChanges={false}
          >
            <EmojiPin category={p.category} selected={p.id === selectedId} />
          </Marker>
        ))}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  pin: {
    width: map.pinSize,
    height: map.pinSize,
    borderRadius: map.pinSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glassStrong,
    borderWidth: map.pinBorder,
    borderColor: colors.glassBorder,
    shadowColor: colors.shadow,
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  pinSelected: {
    borderColor: colors.accent,
  },
  pinEmoji: {
    fontSize: map.pinEmojiSize,
  },
  mini: {
    height: map.miniHeight,
    borderRadius: spacing.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  attribution: {
    fontSize: type.caption,
    color: colors.textSecondary,
  },
  link: {
    textDecorationLine: 'underline',
  },
});

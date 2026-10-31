import * as Location from 'expo-location';

// Foreground location only (background needs a development build; out of scope).
export type Position = { lat: number; lon: number };
export type LocationResult = { ok: true; position: Position } | { ok: false; reason: 'denied' | 'unavailable' };

export async function getPosition(): Promise<LocationResult> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return { ok: false, reason: 'denied' };
    const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { ok: true, position: { lat: fix.coords.latitude, lon: fix.coords.longitude } };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

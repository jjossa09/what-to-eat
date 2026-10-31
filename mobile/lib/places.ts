import { type Place, searchPlaces } from './api';
import type { Position } from './location';

// Map tab places (P1-13): one search, reused until the user moves about 500 m.
export const MAP_RADIUS_M = 3000; // keeps Geoapify's nearest-first order (proximity bias)
const REFETCH_AFTER_M = 500;
const EARTH_RADIUS_M = 6_371_000;

let cache: { at: Position; places: Place[] } | null = null;

export function distanceM(a: Position, b: Position): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Cached places near `at`, or a fresh search if there is no cache or the user moved. */
export async function nearbyPlaces(at: Position): Promise<Place[]> {
  if (cache && distanceM(cache.at, at) < REFETCH_AFTER_M) return cache.places;
  const result = await searchPlaces(at.lat, at.lon, MAP_RADIUS_M);
  cache = { at, places: result.places };
  return result.places;
}

/** Apple Maps directions to a place (opens the Maps app on iPhone). */
export function directionsUrl(lat: number, lon: number): string {
  return `https://maps.apple.com/?daddr=${lat},${lon}`;
}

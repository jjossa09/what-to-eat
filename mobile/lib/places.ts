import { map } from '../theme';
import { type Place, searchPlaces } from './api';
import type { Position } from './location';

// Map tab places (P1-13, P1-23): the search around the user plus "Search this area" searches.
// Every search goes through one per-region cache, so a region is searched at most once per
// app session (Geoapify credits).

export const MAP_RADIUS_M = 3000; // keeps Geoapify's nearest-first order (proximity bias)
const REFETCH_AFTER_M = 500;
const EARTH_RADIUS_M = 6_371_000;
const CACHE_MAX = 20;

/** The visible map area, as react-native-maps reports it. */
export type Region = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

export function distanceM(a: Position, b: Position): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Per-region cache --------------------------------------------------------------

type Search = { center: Position; radiusM: number };

const cache = new Map<string, Place[]>(); // insertion order = age

/** Center to 3 decimals (about 100 m) and radius to 100 m. */
function cacheKey({ center, radiusM }: Search): string {
  return `${center.lat.toFixed(3)},${center.lon.toFixed(3)},${Math.round(radiusM / 100)}`;
}

export function cachedSearch(search: Search): Place[] | null {
  return cache.get(cacheKey(search)) ?? null;
}

/** One /places/search call for this center and radius, unless it is already cached. */
export async function searchArea(search: Search): Promise<Place[]> {
  const key = cacheKey(search);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = await searchPlaces(search.center.lat, search.center.lon, Math.round(search.radiusM));
  cache.set(key, result.places);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return result.places;
}

let lastNearby: Position | null = null;

/** Places around the user: the last nearby search is reused until they move about 500 m. */
export async function nearbyPlaces(at: Position): Promise<Place[]> {
  const center = lastNearby && distanceM(lastNearby, at) < REFETCH_AFTER_M ? lastNearby : at;
  const places = await searchArea({ center, radiusM: MAP_RADIUS_M });
  lastNearby = center;
  return places;
}

// Region math ---------------------------------------------------------------------

export function regionCenter(region: Region): Position {
  return { lat: region.latitude, lon: region.longitude };
}

/** True if the view moved meaningfully since `searched`: a 30% pan or a 1.5x zoom. */
export function regionMoved(searched: Region, now: Region): boolean {
  const panned =
    Math.abs(now.latitude - searched.latitude) > map.moveFraction * searched.latitudeDelta ||
    Math.abs(now.longitude - searched.longitude) > map.moveFraction * searched.longitudeDelta;
  const ratio = now.latitudeDelta / searched.latitudeDelta;
  const zoomed = Math.max(ratio, 1 / ratio) >= map.zoomRatio;
  return panned || zoomed;
}

/** Half the visible diagonal, clamped to 500 m to 15 km. */
export function regionRadiusM(region: Region): number {
  const sw = { lat: region.latitude - region.latitudeDelta / 2, lon: region.longitude - region.longitudeDelta / 2 };
  const ne = { lat: region.latitude + region.latitudeDelta / 2, lon: region.longitude + region.longitudeDelta / 2 };
  const half = distanceM(sw, ne) / 2;
  return Math.round(Math.min(map.maxSearchRadiusM, Math.max(map.minSearchRadiusM, half)));
}

/** The search for the visible region. */
export function regionSearch(region: Region): Search {
  return { center: regionCenter(region), radiusM: regionRadiusM(region) };
}

/**
 * New results merged into the shown pins, deduped by id (a shown pin keeps its entry). Over the
 * cap, the farthest from `center` are dropped, except `keepId` (the selected pin).
 */
export function mergePlaces(shown: Place[], found: Place[], center: Position, keepId: string | null): Place[] {
  const byId = new Map(shown.map((p) => [p.id, p]));
  for (const p of found) if (!byId.has(p.id)) byId.set(p.id, p);
  const all = [...byId.values()];
  if (all.length <= map.maxPins) return all;
  const away = (p: Place) => distanceM(center, { lat: p.lat, lon: p.lon });
  const kept = all.filter((p) => p.id === keepId);
  const rest = all.filter((p) => p.id !== keepId).sort((a, b) => away(a) - away(b));
  return [...kept, ...rest.slice(0, map.maxPins - kept.length)];
}

/** Apple Maps directions to a place (opens the Maps app on iPhone). */
export function directionsUrl(lat: number, lon: number): string {
  return `https://maps.apple.com/?daddr=${lat},${lon}`;
}

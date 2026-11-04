import { useState } from 'react';
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native';

import { SLOTS, type Intent, type Person, type Slot } from '../lib/companion';
import type { HistoryResult, MealDraft, NearbyResult, Pending, ProfileDraft } from '../lib/companionActions';
import { mapInsights } from '../lib/insights';
import { directionsUrl } from '../lib/places';
import type { Category } from '../lib/profile';
import { chart, colors, spacing, type } from '../theme';
import { CompanionMealsChart, FoodBySlotChart, MealDistanceChart, PriceBySlotChart, TopCategoriesChart } from './charts/InsightCharts';
import { OpeningMotion } from './charts/OpeningMotion';
import { Attribution } from './PlaceMap';
import { Chip, GlassCard, PrimaryButton, SecondaryButton } from './ui';

export function PreferenceFields({ value, onChange, categories, disabled = false }: {
  value: ProfileDraft; onChange: (value: ProfileDraft) => void; categories: readonly Category[]; disabled?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? categories : categories.filter((c) => value.favorites.includes(c.id) || value.hard_nos.includes(c.id));
  function toggle(id: string, key: 'favorites' | 'hard_nos') {
    const other = key === 'favorites' ? 'hard_nos' : 'favorites';
    const has = value[key].includes(id);
    onChange({ ...value, [key]: has ? value[key].filter((x) => x !== id) : [...value[key], id],
      [other]: has ? value[other] : value[other].filter((x) => x !== id) });
  }
  return <View style={styles.body}>
    <Text style={styles.label}>Favorites</Text>
    <View style={styles.chips}>{shown.map((c) => <Chip key={c.id} label={c.name} disabled={disabled}
      selected={value.favorites.includes(c.id)} onPress={() => toggle(c.id, 'favorites')} />)}</View>
    <Text style={styles.label}>Never show</Text>
    <View style={styles.chips}>{shown.map((c) => <Chip key={c.id} label={c.name} disabled={disabled}
      selected={value.hard_nos.includes(c.id)} onPress={() => toggle(c.id, 'hard_nos')} />)}</View>
    {!showAll && <Chip label="More cuisines" disabled={disabled} onPress={() => setShowAll(true)} />}
    <Text style={styles.label}>Usual budget</Text>
    <View style={styles.chips}>{[1, 2, 3, 4].map((n) => <Chip key={n} label={'$'.repeat(n)}
      disabled={disabled} selected={value.budget === n} onPress={() => onChange({ ...value, budget: n })} />)}</View>
    <View style={styles.chips}>{[true, false].map((solo) => <Chip key={String(solo)}
      label={solo ? 'Usually solo' : 'Usually with people'} disabled={disabled}
      selected={value.mostly_solo === solo} onPress={() => onChange({ ...value, mostly_solo: solo })} />)}</View>
    {(value.favorites.length < 1 || value.favorites.length > 5) && <Text style={styles.note}>Keep 1 to 5 favorites.</Text>}
    <Text style={styles.note}>Only “Never show” permanently excludes a cuisine.</Text>
  </View>;
}

export function PendingCard({ pending, categories, people, onChange, onConfirm, onCancel,
  onWhere, busy, error, duplicate }: {
  pending: Pending; categories: readonly Category[]; people: readonly Person[];
  onChange: (pending: Pending) => void; onConfirm: (another?: boolean) => void; onCancel: () => void;
  onWhere: (name: string) => void; busy: boolean; error: string | null; duplicate: boolean;
}) {
  const [showFood, setShowFood] = useState(false);
  const [placeName, setPlaceName] = useState('');
  const meal = pending.kind === 'log_meal' ? pending.arguments as MealDraft : null;
  const preferences = pending.kind === 'preference_change' ? pending.arguments as ProfileDraft : null;
  const rating = pending.kind === 'rate_meal' ? pending.arguments as { meal_id: string; revision: number; changes: { stars: number | null } } : null;
  const setMeal = (changes: Partial<MealDraft>) => onChange({ ...pending, arguments: { ...meal!, ...changes } });
  const stars = meal?.stars ?? rating?.changes.stars ?? null;
  const ready = meal ? !!meal.category_id && !!meal.timezone && /^\d{4}-\d{2}-\d{2}$/.test(meal.eaten_on)
    : preferences ? preferences.favorites.length >= 1 && preferences.favorites.length <= 5 : stars !== null;
  return <GlassCard><View style={styles.body}>
    <Text style={styles.label}>{meal ? 'Log this meal?' : preferences ? 'Change your taste profile?' : 'Save this rating?'}</Text>
    {!meal && pending.placeName && <Text style={styles.note}>{pending.placeName}</Text>}
    {meal && <>
      {!meal.timezone && <Text style={styles.error}>Your device timezone is unavailable.</Text>}
      <Chip label={categories.find((c) => c.id === meal.category_id)?.name ?? 'Choose food'} disabled={busy}
        onPress={() => setShowFood(!showFood)} />
      {showFood && <View style={styles.chips}>{categories.map((c) => <Chip key={c.id} label={c.name}
        disabled={busy} selected={meal.category_id === c.id} onPress={() => { setMeal({ category_id: c.id }); setShowFood(false); }} />)}</View>}
      <Text style={styles.label}>Date eaten</Text>
      {pending.dateHint && <Text style={styles.note}>{pending.dateHint}</Text>}
      <TextInput accessibilityLabel="Date eaten" style={styles.input} placeholder="YYYY-MM-DD"
        placeholderTextColor={colors.textSecondary} value={meal.eaten_on} editable={!busy}
        onChangeText={(eaten_on) => setMeal({ eaten_on })} />
      <View style={styles.chips}>{[null, ...SLOTS].map((slot) => <Chip key={slot ?? 'unknown'} label={slot ?? 'Time not set'}
        disabled={busy} selected={meal.meal_slot === slot} onPress={() => setMeal({ meal_slot: slot })} />)}</View>
      <TextInput accessibilityLabel="Dish" style={styles.input} value={meal.dish} maxLength={60}
        placeholder="Dish (optional)" placeholderTextColor={colors.textSecondary} editable={!busy}
        onChangeText={(dish) => setMeal({ dish })} />
      <Text style={styles.note}>{pending.placeName ?? 'Place not set'}</Text>
      {meal.place_id && <Chip label="Clear place" disabled={busy} onPress={() => {
        onChange({ ...pending, placeName: undefined, arguments: { ...meal, place_id: null } });
      }} />}
      <TextInput accessibilityLabel="Where?" style={styles.input} value={placeName} editable={!busy} maxLength={80}
        placeholder="Where? (optional)" placeholderTextColor={colors.textSecondary} onChangeText={setPlaceName} />
      {!!placeName.trim() && <Chip label="Find place" disabled={busy} onPress={() => onWhere(placeName.trim())} />}
      <Text style={styles.label}>Company (optional)</Text>
      <View style={styles.chips}>
        <Chip label="Not set" disabled={busy} selected={meal.solo === null && !meal.companion_ids.length}
          onPress={() => setMeal({ solo: null, companion_ids: [] })} />
        <Chip label="Solo" disabled={busy} selected={meal.solo === true}
          onPress={() => setMeal({ solo: true, companion_ids: [] })} />
        {people.map((p) => <Chip key={p.id} label={p.name} disabled={busy} selected={meal.companion_ids.includes(p.id)}
          onPress={() => setMeal({ solo: false, companion_ids: meal.companion_ids.includes(p.id)
            ? meal.companion_ids.filter((x) => x !== p.id) : [...meal.companion_ids, p.id] })} />)}
      </View>
    </>}
    {preferences && <PreferenceFields value={preferences} categories={categories} disabled={busy}
      onChange={(arguments_) => onChange({ ...pending, arguments: arguments_ })} />}
    {(meal || rating) && <>
      <Text style={styles.label}>Your rating{meal ? ' (optional)' : ''}</Text>
      <View style={styles.chips}>{[1, 2, 3, 4, 5].map((n) => <Chip key={n} label={`${n} ★`} disabled={busy}
        selected={stars === n} onPress={() => meal ? setMeal({ stars: n })
          : onChange({ ...pending, arguments: { ...rating!, changes: { stars: n } } })} />)}</View>
    </>}
    {duplicate && <Text style={styles.note}>A matching meal exists; add another?</Text>}
    {error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    <PrimaryButton label={duplicate ? 'Add another' : 'Confirm'} disabled={!ready} busy={busy}
      feedback={false} onPress={() => onConfirm(duplicate)} />
    <SecondaryButton label="Cancel" disabled={busy} onPress={onCancel} />
  </View></GlassCard>;
}

export function NearbyCard({ data, onSelect }: { data: NearbyResult; onSelect?: (place: NearbyResult['places'][number]) => void }) {
  const [all, setAll] = useState(false);
  return <GlassCard><View style={styles.body}>
    <Text style={styles.label}>Nearby</Text>
    {data.widened && <Text style={styles.note}>Search widened to 25 miles.</Text>}
    {!data.places.length && <Text style={styles.note}>No verified matches in this search.</Text>}
    {data.places.slice(0, all ? undefined : 3).map((p) => <View key={p.id} style={styles.body}>
      <Text style={styles.label}>{p.name}</Text>
      <Text style={styles.note}>{(p.distance_m / 1609.344).toFixed(1)} mi{p.address ? ` · ${p.address}` : ''}</Text>
      <View style={styles.chips}><Chip label="Directions" onPress={() => Linking.openURL(directionsUrl(p.lat, p.lon))} />
        {onSelect && <Chip label="Use this place" onPress={() => onSelect(p)} />}</View>
    </View>)}
    {!all && data.places.length > 3 && <Chip label="More matches" onPress={() => setAll(true)} />}
    {data.truncated && <Text style={styles.note}>Provider results are limited.</Text>}
    <Attribution />
  </View></GlassCard>;
}

export function MealReferenceCard({ reference, categories, onFind, onCancel }: {
  reference: Extract<Intent, { type: 'rate_meal' }>; categories: readonly Category[];
  onFind: (intent: Extract<Intent, { type: 'rate_meal' }>) => void; onCancel: () => void;
}) {
  const [day, setDay] = useState('');
  const [category, setCategory] = useState(reference.category);
  const needsDate = reference.reference === 'date' || reference.date?.kind === 'weekday';
  return <GlassCard><View style={styles.body}>
    <Text style={styles.label}>Which meal did you mean?</Text>
    {needsDate && <TextInput accessibilityLabel="Meal reference date" value={day} style={styles.input}
      placeholder="YYYY-MM-DD" placeholderTextColor={colors.textSecondary} onChangeText={setDay} />}
    {reference.reference === 'food' && !reference.category && <View style={styles.chips}>{categories.map((c) =>
      <Chip key={c.id} label={c.name} selected={category === c.id} onPress={() => setCategory(c.id)} />)}</View>}
    <PrimaryButton label="Find meal" disabled={needsDate && !/^\d{4}-\d{2}-\d{2}$/.test(day)
      || reference.reference === 'food' && !category} onPress={() => onFind({ ...reference, category,
        date: needsDate ? { kind: 'iso', value: day } : reference.date })} />
    <SecondaryButton label="Cancel" onPress={onCancel} />
  </View></GlassCard>;
}

export function HistoryCard({ data, categories, people }: { data: HistoryResult; categories: Category[]; people: Person[] }) {
  const mapped = mapInsights(data.stats, people, categories, chart.categories);
  const [slot, setSlot] = useState<Slot>('lunch');
  const props = { data: mapped.cards[data.chart_id] };
  return <OpeningMotion cards={mapped.cards} selectedSlot={slot}><GlassCard><View style={styles.body}>
    <Text style={styles.note}>{data.from_date} to {data.to_date}</Text>
    <Text style={styles.label}>{data.line}</Text>
    {(data.note || mapped.note) && <Text style={styles.note}>{data.note ?? mapped.note}</Text>}
    {data.chart_id === 'top' && <TopCategoriesChart {...props} />}
    {data.chart_id === 'food' && <FoodBySlotChart {...props} />}
    {data.chart_id === 'price' && <PriceBySlotChart {...props} />}
    {data.chart_id === 'distance' && <MealDistanceChart {...props} selectedSlot={slot} onSlotChange={setSlot} />}
    {data.chart_id === 'companions' && <CompanionMealsChart {...props} />}
  </View></GlassCard></OpeningMotion>;
}

const styles = StyleSheet.create({
  body: { gap: spacing.md }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  label: { color: colors.text, fontSize: type.body, fontWeight: '600' },
  note: { color: colors.textSecondary, fontSize: type.small }, error: { color: colors.error, fontSize: type.small },
  input: { color: colors.text, backgroundColor: colors.glassStrong, padding: spacing.md, fontSize: type.body },
});

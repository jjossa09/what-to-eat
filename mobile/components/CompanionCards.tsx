import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { calendarDate, calendarDays, displayMealDate, localMealDate, SLOTS, validMealDate,
  type Intent, type Person, type Slot } from '../lib/companion';
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

/** Native controls and local calendar arithmetic; no dependency, network or date guessing. */
export function MealDatePicker({ value, onChange, disabled = false, now = new Date() }: {
  value: string; onChange: (iso: string) => void; disabled?: boolean; now?: Date;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => validMealDate(value, now) ? localMealDate(value)! : new Date(now));
  const today = calendarDate(now);
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const days = calendarDays(month);
  function choose(iso: string) {
    if (disabled || !validMealDate(iso, now)) return;
    onChange(iso); setOpen(false);
  }
  function move(delta: number) {
    const next = new Date(month); next.setDate(1); next.setMonth(next.getMonth() + delta);
    if (disabled || next.getFullYear() < 1 || calendarDate(next) > today) return;
    setMonth(next);
  }
  return <View style={styles.body}>
    <Text style={styles.note}>{displayMealDate(value)}</Text>
    <View style={styles.chips}>
      <Chip label="Today" disabled={disabled} selected={value === today} onPress={() => choose(today)} />
      <Chip label="Yesterday" disabled={disabled} selected={value === calendarDate(yesterday)}
        onPress={() => choose(calendarDate(yesterday))} />
      <Chip label={open ? 'Close calendar' : 'Choose date'} disabled={disabled} onPress={() => {
        setMonth(validMealDate(value, now) ? localMealDate(value)! : new Date(now)); setOpen(!open);
      }} />
    </View>
    {open && <View style={styles.body}>
      <View style={styles.calendarHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous month" disabled={disabled}
          onPress={() => move(-1)} style={styles.calendarArrow}><Text style={styles.label}>‹</Text></Pressable>
        <Text style={styles.label}>{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Next month"
          accessibilityState={{ disabled: disabled || month.getFullYear() === now.getFullYear() && month.getMonth() >= now.getMonth() }}
          disabled={disabled || month.getFullYear() === now.getFullYear() && month.getMonth() >= now.getMonth()}
          onPress={() => move(1)} style={styles.calendarArrow}><Text style={styles.label}>›</Text></Pressable>
      </View>
      <View style={styles.calendarRow}>{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) =>
        <View key={i} style={styles.calendarDay}><Text style={styles.note}>{day}</Text></View>)}</View>
      {Array.from({ length: 6 }, (_, week) => <View key={week} style={styles.calendarRow}>
        {days.slice(week * 7, week * 7 + 7).map((iso, i) => iso === null
          ? <View key={`empty-${i}`} style={styles.calendarDay} />
          : <Pressable key={iso} accessibilityRole="button" accessibilityLabel={displayMealDate(iso)}
            accessibilityState={{ selected: value === iso, disabled: disabled || iso > today }}
            disabled={disabled || iso > today} onPress={() => choose(iso)}
            style={[styles.calendarDay, value === iso && styles.calendarSelected, iso > today && styles.calendarDisabled]}>
            <Text style={styles.note}>{Number(iso.slice(-2))}</Text>
          </Pressable>)}
      </View>)}
    </View>}
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
  const [editing, setEditing] = useState(false);
  const meal = pending.kind === 'log_meal' ? pending.arguments as MealDraft : null;
  const preferences = pending.kind === 'preference_change' ? pending.arguments as ProfileDraft : null;
  const rating = pending.kind === 'rate_meal' ? pending.arguments as { meal_id: string; revision: number; changes: { stars: number | null } } : null;
  const setMeal = (changes: Partial<MealDraft>) => onChange({ ...pending, arguments: { ...meal!, ...changes } });
  const stars = meal?.stars ?? rating?.changes.stars ?? null;
  const ready = meal ? !!meal.category_id && !!meal.timezone && validMealDate(meal.eaten_on)
    : preferences ? preferences.favorites.length >= 1 && preferences.favorites.length <= 5 : stars !== null;
  return <GlassCard><View style={styles.body}>
    <Text style={styles.label}>{meal ? 'Log this meal?' : preferences ? 'Change your taste profile?' : 'Save this rating?'}</Text>
    {!meal && pending.placeName && <Text style={styles.note}>{pending.placeName}</Text>}
    {meal && <>
      <Text style={styles.note}>{meal.dish || categories.find((c) => c.id === meal.category_id)?.name || 'Food not set'}</Text>
      {!!meal.dish && <Text style={styles.note}>{categories.find((c) => c.id === meal.category_id)?.name ?? 'Food category not set'}</Text>}
      <Text style={styles.note}>{displayMealDate(meal.eaten_on)} · {meal.meal_slot ?? 'Time not set'}</Text>
      {!editing && !meal.eaten_on && <MealDatePicker value={meal.eaten_on} disabled={busy}
        onChange={(eaten_on) => onChange({ ...pending, dateHint: undefined, arguments: { ...meal, eaten_on } })} />}
      <Text style={styles.note}>{meal.place_id && pending.placeName ? pending.placeName : 'Without a restaurant'}</Text>
      {!!meal.companion_ids.length && <Text style={styles.note}>{people.filter((p) => meal.companion_ids.includes(p.id)).map((p) => p.name).join(', ')}</Text>}
      {meal.solo === true && <Text style={styles.note}>Solo</Text>}
      {meal.stars !== null && <Text style={styles.note}>{meal.stars} ★</Text>}
      <Chip label={editing ? 'Done editing' : 'Edit'} disabled={busy} onPress={() => setEditing(!editing)} />
    </>}
    {meal && editing && <>
      {!meal.timezone && <Text style={styles.error}>Your device timezone is unavailable.</Text>}
      <Chip label={categories.find((c) => c.id === meal.category_id)?.name ?? 'Choose food'} disabled={busy}
        onPress={() => setShowFood(!showFood)} />
      {showFood && <View style={styles.chips}>{categories.map((c) => <Chip key={c.id} label={c.name}
        disabled={busy} selected={meal.category_id === c.id} onPress={() => { setMeal({ category_id: c.id }); setShowFood(false); }} />)}</View>}
      <Text style={styles.label}>Date eaten</Text>
      {pending.dateHint && <Text style={styles.note}>{pending.dateHint}</Text>}
      <MealDatePicker value={meal.eaten_on} disabled={busy}
        onChange={(eaten_on) => onChange({ ...pending, dateHint: undefined, arguments: { ...meal, eaten_on } })} />
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
    {((meal && editing) || rating) && <>
      <Text style={styles.label}>Your rating{meal ? ' (optional)' : ''}</Text>
      <View style={styles.chips}>{[1, 2, 3, 4, 5].map((n) => <Chip key={n} label={`${n} ★`} disabled={busy}
        selected={stars === n} onPress={() => meal ? setMeal({ stars: n })
          : onChange({ ...pending, arguments: { ...rating!, changes: { stars: n } } })} />)}</View>
    </>}
    {duplicate && <Text style={styles.note}>A matching meal exists; add another?</Text>}
    {error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    <PrimaryButton label={duplicate ? 'Add another' : meal ? 'Save' : 'Confirm'} disabled={!ready} busy={busy}
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
  const needsDate = reference.reference === 'date'
    || reference.date?.kind === 'weekday' || reference.date?.kind === 'last_weekday';
  return <GlassCard><View style={styles.body}>
    <Text style={styles.label}>Which meal did you mean?</Text>
    {needsDate && <MealDatePicker value={day} onChange={setDay} />}
    {reference.reference === 'food' && !reference.category && <View style={styles.chips}>{categories.map((c) =>
      <Chip key={c.id} label={c.name} selected={category === c.id} onPress={() => setCategory(c.id)} />)}</View>}
    <PrimaryButton label="Find meal" disabled={needsDate && !validMealDate(day)
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
    <Text style={styles.note}>{displayMealDate(data.from_date)} to {displayMealDate(data.to_date)}</Text>
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
  calendarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calendarArrow: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  calendarRow: { flexDirection: 'row' },
  calendarDay: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  calendarSelected: { backgroundColor: colors.glassStrong, borderColor: colors.accent, borderWidth: 1 },
  calendarDisabled: { opacity: 0.35 },
  body: { gap: spacing.md }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  label: { color: colors.text, fontSize: type.body, fontWeight: '600' },
  note: { color: colors.textSecondary, fontSize: type.small }, error: { color: colors.error, fontSize: type.small },
  input: { color: colors.text, backgroundColor: colors.glassStrong, padding: spacing.md, fontSize: type.body },
});

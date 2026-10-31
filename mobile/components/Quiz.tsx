import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { type Category, loadCategories, MAX_FAVORITES, type QuizAnswers, saveTasteQuiz } from '../lib/profile';
import { Chip, colors, Dots, GlassCard, GlassScreen, PrimaryButton, TextLink } from './ui';

// Taste quiz (P1-08, FR1, FR2). One question per screen (R1). Saved once at the end.

type Budget = QuizAnswers['budget'];

const BUDGETS: { level: Budget; label: string; detail: string }[] = [
  { level: 1, label: '$', detail: 'Under $15' },
  { level: 2, label: '$$', detail: '$15 to 30' },
  { level: 3, label: '$$$', detail: '$30 to 60' },
  { level: 4, label: '$$$$', detail: 'Over $60' },
];

const MAX_COMPANIONS = 20;
const MAX_NAME = 40;

export default function Quiz({ onDone }: { onDone: () => void }) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState(0);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [hardNos, setHardNos] = useState<string[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [mostlySolo, setMostlySolo] = useState<boolean | null>(null);
  const [companions, setCompanions] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const fetchCategories = useCallback(
    (isLive: () => boolean = () => true) =>
      loadCategories()
        .then((rows) => isLive() && setCategories(rows))
        .catch(() => isLive() && setLoadFailed(true)),
    [],
  );

  useEffect(() => {
    let live = true;
    fetchCategories(() => live);
    return () => {
      live = false;
    };
  }, [fetchCategories]);

  function retryLoad() {
    setLoadFailed(false);
    fetchCategories();
  }

  function toggleFavorite(id: string) {
    if (favorites.includes(id)) {
      setFavorites(favorites.filter((f) => f !== id));
    } else if (favorites.length < MAX_FAVORITES) {
      setFavorites([...favorites, id]);
      setHardNos(hardNos.filter((h) => h !== id));
    }
    // A 6th pick does nothing.
  }

  function toggleHardNo(id: string) {
    setHardNos(hardNos.includes(id) ? hardNos.filter((h) => h !== id) : [...hardNos, id]);
  }

  function addCompanion() {
    const trimmed = name.trim();
    const taken = companions.some((c) => c.toLowerCase() === trimmed.toLowerCase());
    if (trimmed && !taken && companions.length < MAX_COMPANIONS) {
      setCompanions([...companions, trimmed]);
    }
    setName('');
  }

  async function save(solo: boolean) {
    if (budget === null || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await saveTasteQuiz({ favorites, hardNos, budget, mostlySolo: solo, companions });
      onDone();
    } catch {
      setSaveFailed(true);
      setSaving(false);
    }
  }

  function chooseSolo(solo: boolean) {
    setMostlySolo(solo);
    setSaveFailed(false);
    if (solo) {
      save(true);
    } else {
      setStep(4);
    }
  }

  if (!categories) {
    return (
      <GlassScreen>
        <View style={styles.center}>
          {loadFailed ? (
            <>
              <Text style={styles.hint}>Couldn&apos;t load.</Text>
              <PrimaryButton label="Retry" onPress={retryLoad} />
            </>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      </GlassScreen>
    );
  }

  const total = mostlySolo === false ? 5 : 4;
  const back = () => {
    setSaveFailed(false);
    setStep(step - 1);
  };

  let title = '';
  let hint: string | null = null;
  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (step === 0) {
    title = 'What do you love?';
    hint = 'Pick up to 5';
    body = (
      <View style={styles.wrap}>
        {categories.map((c) => (
          <Chip
            key={c.id}
            label={c.name}
            selected={favorites.includes(c.id)}
            onPress={() => toggleFavorite(c.id)}
          />
        ))}
      </View>
    );
    footer = <PrimaryButton label="Next" disabled={favorites.length === 0} onPress={() => setStep(1)} />;
  } else if (step === 1) {
    title = 'Anything you never eat?';
    body = (
      <View style={styles.wrap}>
        {categories
          .filter((c) => !favorites.includes(c.id))
          .map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              selected={hardNos.includes(c.id)}
              onPress={() => toggleHardNo(c.id)}
            />
          ))}
      </View>
    );
    footer = <PrimaryButton label={hardNos.length ? 'Next' : 'Skip'} onPress={() => setStep(2)} />;
  } else if (step === 2) {
    title = 'Budget for your own meal?';
    body = (
      <View style={styles.stack}>
        {BUDGETS.map((b) => (
          <Chip
            key={b.level}
            wide
            label={b.label}
            detail={b.detail}
            selected={budget === b.level}
            onPress={() => {
              setBudget(b.level);
              setStep(3);
            }}
          />
        ))}
      </View>
    );
  } else if (step === 3) {
    title = 'Solo or with people?';
    body = (
      <View style={styles.stack}>
        <Chip wide label="Solo" selected={mostlySolo === true} onPress={() => chooseSolo(true)} />
        <Chip wide label="With people" selected={mostlySolo === false} onPress={() => chooseSolo(false)} />
        {saving && <ActivityIndicator style={styles.spinner} />}
      </View>
    );
  } else {
    title = 'Who do you eat with?';
    body = (
      <View style={styles.stack}>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            placeholder="Name"
            placeholderTextColor={colors.muted}
            value={name}
            onChangeText={setName}
            onSubmitEditing={addCompanion}
            submitBehavior="submit"
            returnKeyType="done"
            autoCapitalize="words"
            maxLength={MAX_NAME}
          />
          <Pressable
            onPress={addCompanion}
            accessibilityRole="button"
            style={({ pressed }) => [styles.add, pressed && styles.pressed]}
          >
            <Text style={styles.addText}>Add</Text>
          </Pressable>
        </View>
        {companions.length > 0 && (
          <View style={styles.wrap}>
            {companions.map((c) => (
              <Chip key={c} label={c} onRemove={() => setCompanions(companions.filter((x) => x !== c))} />
            ))}
          </View>
        )}
      </View>
    );
    footer = (
      <PrimaryButton label={companions.length ? 'Done' : 'Skip'} busy={saving} onPress={() => save(false)} />
    );
  }

  return (
    <GlassScreen>
      <Dots step={step} total={total} />
      <View style={styles.backRow}>{step > 0 && !saving && <TextLink label="Back" onPress={back} />}</View>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <GlassCard>
          <View style={styles.heading}>
            <Text style={styles.title}>{title}</Text>
            {hint && <Text style={styles.hint}>{hint}</Text>}
          </View>
          {body}
        </GlassCard>
      </ScrollView>
      <View style={styles.footer}>
        {saveFailed && <Text style={styles.error}>Couldn&apos;t save. Try again.</Text>}
        {footer}
      </View>
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'stretch',
    gap: 16,
  },
  backRow: {
    height: 32,
    justifyContent: 'center',
    marginTop: 8,
  },
  scroll: {
    paddingBottom: 16,
  },
  heading: {
    gap: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: colors.ink,
  },
  hint: {
    fontSize: 15,
    color: colors.muted,
    textAlign: 'left',
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  stack: {
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(17,17,17,0.08)',
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: colors.ink,
  },
  add: {
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderRadius: 999,
    backgroundColor: colors.ink,
  },
  addText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
  spinner: {
    marginTop: 6,
  },
  footer: {
    gap: 10,
  },
  error: {
    color: colors.error,
    textAlign: 'center',
  },
});

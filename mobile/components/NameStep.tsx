import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { setDisplayName } from '../lib/profile';
import { colors, radii, spacing, type } from '../theme';
import { GlassCard, GlassScreen, PrimaryButton } from './ui';

// Asked once after the quiz (P1-22). Required: there is no skip.

const MAX_NAME = 40;

export default function NameStep({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const clean = name.trim();

  async function save() {
    if (!clean || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await setDisplayName(clean);
      onDone();
    } catch {
      setFailed(true);
      setSaving(false);
    }
  }

  return (
    <GlassScreen>
      <View style={styles.center}>
        <GlassCard>
          <Text style={styles.title}>What should we call you?</Text>
          <TextInput
            style={styles.input}
            placeholder="Name"
            placeholderTextColor={colors.textSecondary}
            value={name}
            onChangeText={setName}
            onSubmitEditing={save}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="givenName"
            returnKeyType="done"
            maxLength={MAX_NAME}
          />
        </GlassCard>
        {failed && <Text style={styles.error}>Couldn&apos;t save. Try again.</Text>}
        <PrimaryButton label="Continue" disabled={!clean} busy={saving} onPress={save} />
      </View>
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.lg,
  },
  title: {
    fontSize: type.title,
    fontWeight: '600',
    color: colors.text,
  },
  input: {
    backgroundColor: colors.glassStrong,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: type.body,
    color: colors.text,
  },
  error: {
    color: colors.error,
    textAlign: 'center',
  },
});

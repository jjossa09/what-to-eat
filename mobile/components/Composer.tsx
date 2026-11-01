import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radii, spacing, type } from '../theme';
import PressScale from './PressScale';

// One-line chat input (P1-21, P1-14): typed answers go to Muse for parsing, never as is.
// Always shown in the chat (P1-19); disabled while a round loads or after an error.

const MAX_TEXT = 200; // matches the API's limit

type Props = {
  placeholder: string;
  onSend: (text: string) => void;
  busy?: boolean;
  disabled?: boolean;
};

export default function Composer({ placeholder, onSend, busy = false, disabled = false }: Props) {
  const [text, setText] = useState('');
  const ready = text.trim().length > 0 && !busy && !disabled;

  function send() {
    if (!ready) return;
    onSend(text.trim());
    setText('');
  }

  return (
    <View style={styles.row}>
      <TextInput
        style={[styles.input, disabled && styles.inputOff]}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        value={text}
        onChangeText={setText}
        onSubmitEditing={send}
        submitBehavior="submit"
        returnKeyType="send"
        maxLength={MAX_TEXT}
        editable={!busy && !disabled}
      />
      <PressScale
        onPress={send}
        disabled={!ready}
        accessibilityRole="button"
        accessibilityLabel="Send"
        accessibilityState={{ disabled: !ready, busy }}
        style={[styles.send, !ready && styles.sendOff]}
      >
        {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.sendText}>Send</Text>}
      </PressScale>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.glassStrong,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: type.body,
    color: colors.text,
  },
  inputOff: {
    opacity: 0.6,
  },
  send: {
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  sendOff: {
    opacity: 0.5,
  },
  sendText: {
    fontSize: type.body,
    fontWeight: '600',
    color: colors.onAccent,
  },
});

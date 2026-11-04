import * as Haptics from 'expo-haptics';
import { AppState } from 'react-native';

export type HapticKind = 'light' | 'selection' | 'success';

/** One owner per user action. Haptics never block an action or run in the background. */
export function haptic(kind: HapticKind): void {
  if (AppState.currentState !== 'active') return;
  try {
    const request = kind === 'selection' ? Haptics.selectionAsync()
      : kind === 'success' ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    request.catch(() => undefined);
  } catch {
    // Unsupported hardware must never interrupt the interaction.
  }
}

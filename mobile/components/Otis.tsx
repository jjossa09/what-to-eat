import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import type { OtisState } from '../lib/otis';
import { otis, spacing } from '../theme';
import { otisAssets, type OtisAssets } from './otisAssets';

// Keep the controller's state/visibility contract for future artwork. Static presentation
// deliberately does not react to those values or subscribe to motion preferences.
type Props = { state: OtisState; active: boolean; keyboard: boolean; assets?: OtisAssets | null };

export default function Otis({ keyboard, assets = otisAssets }: Props) {
  const [failed, setFailed] = useState<OtisAssets | null>(null);
  if (!assets || failed === assets) return null;
  const size = keyboard ? otis.compactSize : otis.size;
  return (
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mascot, { width: size, height: size }]}>
      <Image source={assets.idle} resizeMode="contain" fadeDuration={0} style={StyleSheet.absoluteFill}
        accessible={false} onError={() => setFailed(assets)} />
    </View>
  );
}

const styles = StyleSheet.create({ mascot: { alignSelf: 'center', marginBottom: spacing.xs } });

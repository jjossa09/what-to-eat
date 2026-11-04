import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import type { OtisState } from '../lib/otis';
import { otis, spacing } from '../theme';
import GlassFrame from './GlassFrame';
import { otisAssets, type OtisAssets } from './otisAssets';

// Keep the controller's state/visibility contract for future artwork. Static presentation
// deliberately does not react to those values or subscribe to motion preferences.
type Props = {
  state: OtisState; active: boolean; keyboard: boolean; assets?: OtisAssets | null;
  onUnavailable?: () => void;
};

export default function Otis({ keyboard, assets = otisAssets, onUnavailable }: Props) {
  const [failed, setFailed] = useState<OtisAssets | null>(null);
  if (!assets || failed === assets) return null;
  const size = keyboard ? otis.compactSize : otis.size;
  const diameter = size + 2 * spacing.sm;
  return (
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mascot, { width: diameter, height: diameter }]}>
      <GlassFrame shape="circle" size={diameter} variant="frosted" style={styles.glass}>
        {/* Explicit dimensions override the bundled PNG's intrinsic size on iOS. */}
        <Image source={assets.idle} resizeMode="contain" fadeDuration={0} style={{ width: size, height: size }}
          accessible={false} onError={() => { setFailed(assets); onUnavailable?.(); }} />
      </GlassFrame>
    </View>
  );
}

const styles = StyleSheet.create({
  mascot: { position: 'absolute', top: 0, alignSelf: 'center' },
  glass: { alignItems: 'center', justifyContent: 'center' },
});

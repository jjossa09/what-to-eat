import { StyleSheet, Text, View } from 'react-native';

import { GlassScreen, useTabBarSpace } from '../components/ui';
import { colors, type } from '../theme';

// Placeholder until P1-13 builds the map.
export default function MapScreen() {
  const space = useTabBarSpace();
  return (
    <GlassScreen tabBar>
      <View style={[styles.center, { paddingBottom: space }]}>
        <Text style={styles.text}>Map is coming soon.</Text>
      </View>
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    fontSize: type.body,
    color: colors.textSecondary,
  },
});

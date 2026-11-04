import type { ImageRequireSource } from 'react-native';

/** Static fallback. Other approved poses stay on disk without runtime references. */
export type OtisAssets = Readonly<{ idle: ImageRequireSource }>;

export const otisAssets: OtisAssets = {
  idle: require('../assets/otis/otis_idle.png'),
};

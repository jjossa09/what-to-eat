// The app theme (P1-22). The only file with color values: every screen and component reads
// from here. Warm cream to apricot gradient, one accent used sparingly, iOS-style glass.

export const colors = {
  gradient: ['#FFF7EE', '#FFE6CC', '#FFD0A8'] as const,
  accent: '#F2552C', // primary buttons, selected chips, active tab only
  onAccent: '#FFFFFF',
  textInverse: '#FFFFFF',
  text: '#1F1A17',
  textSecondary: '#6B5E57',
  error: '#C2410C',
  glass: 'rgba(255,255,255,0.6)',
  glassStrong: 'rgba(255,255,255,0.8)',
  glassBorder: 'rgba(255,255,255,0.9)',
  hairline: 'rgba(31,26,23,0.08)',
  shadow: '#1F1A17',
  star: '#F2552C',
  starEmpty: 'rgba(31,26,23,0.18)',
  dot: 'rgba(31,26,23,0.15)',
  transparent: 'transparent',
  scrim: 'rgba(31,26,23,0.28)', // dims the app behind the feedback pop-up
  accentSoft: 'rgba(242,85,44,0.12)', // warm tint behind the pop-up's emoji
  accentDark: '#B23A17', // text on light glass over a map (about 9:1 on white)
  accentLight: '#FF8A5C',
  scrollThumb: 'rgba(31,26,23,0.32)',
};

export const blur = {
  intensity: 40,
  tint: 'light' as const,
};

// Shared glass frame (P1-19, P1-24): the map's "What to eat?!" button and the meal detail card.
// The interior is fully clear glass (Liquid Glass "clear" on iOS 26+, else a light blur with no
// tint). The accent gradient lives only in the rim: strong at the edge, fading to transparent
// within rim.width inward; nothing red under the center. Bottom to top (the background runs
// top to bottom).
export const frame = {
  gradient: [colors.accentLight, colors.accent, colors.accentDark] as const, // bottom to top
  start: { x: 0.5, y: 1 },
  end: { x: 0.5, y: 0 },
  glassStyle: 'clear' as const, // Liquid Glass (expo-glass-effect: 'clear' | 'regular' | 'none')
  blurIntensity: 20, // fallback below iOS 26: a BlurView with no tint layer
  // Rim bands from the edge inward; opacity = edgeOpacity * (1 - i / bands) ^ falloff.
  rim: { width: 11, bands: 12, edgeOpacity: 0.9, falloff: 2 },
  shadowOpacity: 0.18,
  shadowRadius: 14,
  shadowOffsetY: 6,
  fabSize: 92,
  fabTextSize: 15,
  fabLineHeight: 17,
};

// Meal detail card (P1-24): a centered square that zooms out of the tapped row.
export const mealCard = {
  maxSize: 380, // the square's side, at most; else the screen width minus the side gutters
  openSpring: { stiffness: 260, damping: 26, mass: 1 },
  closeMs: 220,
  fadeMs: 180, // Reduce Motion: a fade instead of the zoom
  swipeCloseDy: 120, // drag down this far, or...
  swipeCloseVy: 1.0, // ...flick this fast, to close
  emojiSize: 34,
  // Behind the card: a light blur of the screen, no darkening, so the clear glass card stands
  // out the way the map button does over the map.
  backdropBlur: 14,
  backdropTint: 'light' as const,
};

// Chat scroll indicator (P1-19): thicker than the native one, at the screen's right edge.
export const scrollBar = {
  width: 5,
  edgeInset: 3, // from the screen's right edge
  minThumb: 36,
  fadeInMs: 120,
  fadeOutMs: 300,
  holdMs: 700, // visible this long after scrolling stops
};

// Floating tab bar (iOS 26 dock style): a capsule inset from the screen edges.
export const dock = {
  height: 62,
  sideInset: 24, // from the left and right screen edges
  bottomInset: 16, // from the bottom, or the home indicator if that is higher
  iconSize: 22,
  labelSize: 10,
  shadowOpacity: 0.12,
  shadowRadius: 20,
};

// Press feedback: a quick critically damped press-in, a soft release (overshoot about 1.003).
export const motion = {
  pressedScale: 0.96,
  pressIn: { stiffness: 400, damping: 40, mass: 1 },
  release: { stiffness: 300, damping: 22, mass: 1 },
  // One small bounce when the Map tab opens (the "What to eat?!" button).
  bounce: { scale: 1.08, upMs: 140, settle: { stiffness: 260, damping: 14, mass: 1 } },
};

// "…" bubble while a typed message is parsed (P1-19): three dots pulsing in turn.
export const typing = {
  dotSize: 7,
  gap: 5,
  stepMs: 180, // delay between dots
  pulseMs: 360, // one fade up or down
  dimOpacity: 0.3,
};

// Maps (P1-13): emoji pins, the chat's mini map, the Map tab's starting zoom.
export const map = {
  pinSize: 36,
  pinEmojiSize: 18,
  pinBorder: 2,
  miniHeight: 160,
  fitPadding: 40,
  startDelta: 0.03, // about 3 km across
  // "Search this area" (P1-23)
  moveFraction: 0.3, // center moved more than 30% of the searched span
  zoomRatio: 1.5, // or the span changed by 1.5x or more
  minSearchRadiusM: 500,
  maxSearchRadiusM: 15000,
  maxPins: 300,
};

export const radii = {
  card: 28,
  bubble: 20,
  pill: 999,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
};

export const type = {
  title: 26,
  heading: 20,
  body: 16,
  small: 15,
  caption: 12,
  fine: 11, // results attribution
};

// One emoji per ML2 category (shown on picks and meals). Other is the fallback.
export const categoryEmoji: Record<string, string> = {
  burgers: '🍔',
  pizza: '🍕',
  mexican: '🌮',
  latin: '🫔',
  chinese: '🥡',
  japanese_sushi: '🍣',
  korean: '🥘',
  thai: '🍜',
  vietnamese: '🍲',
  indian: '🍛',
  mediterranean: '🥙',
  italian: '🍝',
  french: '🥐',
  american_diner: '🍟',
  bbq: '🍖',
  chicken_wings: '🍗',
  sandwiches: '🥪',
  seafood: '🦐',
  salads_bowls: '🥗',
  breakfast_brunch: '🍳',
  coffee_bakery: '☕',
  smoothies_juice: '🥤',
  dessert: '🍰',
  pubs_bars: '🍺',
  other: '🍽️',
};

export function emojiFor(category: string | null | undefined): string {
  return (category && categoryEmoji[category]) || categoryEmoji.other;
}

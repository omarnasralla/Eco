/**
 * Colour adaptation for chart marks.
 *
 * Category colours are chosen by the user and stored as a single hex, but a
 * chart has two surfaces to sit on. A colour picked to look right on white
 * (say a deep violet at OKLCH L 0.43) disappears against a near-black card,
 * and a pale yellow picked in dark mode washes out on white.
 *
 * Rather than storing two hexes — which would put the burden on the user to
 * pick twice, and would still not cover a colour typed into the picker — we
 * store one and clamp its *lightness* into the target mode's band at render
 * time, preserving hue and chroma. The mark stays recognisably "their" colour
 * and stays legible on both grounds.
 *
 * Bands come from the data-viz validator: L 0.43–0.77 on light, 0.48–0.67 on
 * dark (OKLCH).
 */

/**
 * OKLCH lightness bands from the data-viz validator, inset slightly at each
 * edge: quantising a clamped colour back to 8-bit hex can land it a thousandth
 * outside the band it was just clamped into, which then fails validation.
 */
const BANDS = {
  light: [0.435, 0.765],
  dark: [0.485, 0.665],
} as const;

/** Below this chroma a hue reads as gray — deliberate for "Miscellaneous". */
const CHROMA_FLOOR = 0.04;

interface Oklch {
  l: number;
  c: number;
  h: number;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalised = hex.replace('#', '');
  const full =
    normalised.length === 3
      ? normalised
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : normalised;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as [number, number, number];

  // Linear sRGB → LMS → OKLab (Björn Ottosson's matrices).
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  return {
    l: L,
    c: Math.sqrt(a * a + bb * bb),
    h: Math.atan2(bb, a),
  };
}

export function oklchToHex({ l, c, h }: Oklch): string {
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return rgbToHex(
    linearToSrgb(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    linearToSrgb(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    linearToSrgb(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  );
}

/**
 * Clamps a colour's lightness into the band that reads correctly on `mode`'s
 * surface. Hue and chroma are untouched, so the result is the same colour —
 * just a step the eye can actually resolve against that background.
 */
export function adaptToSurface(hex: string, mode: 'light' | 'dark'): string {
  try {
    const colour = hexToOklch(hex);
    const [min, max] = BANDS[mode];

    // Near-neutral colours (an intentional gray for "Miscellaneous") are left
    // alone apart from the clamp: nudging their chroma would invent a hue the
    // user did not choose.
    const clamped = Math.max(min, Math.min(max, colour.l));
    if (clamped === colour.l) return hex;

    return oklchToHex({ ...colour, l: clamped });
  } catch {
    // A malformed stored value must not take the chart down with it.
    return hex;
  }
}

export function isNeutral(hex: string): boolean {
  try {
    return hexToOklch(hex).c < CHROMA_FLOOR;
  } catch {
    return false;
  }
}

/**
 * Series colours for charts that are not keyed to a user-chosen category —
 * the income/expense trend, the forecast band, the payoff projection.
 *
 * These are the validated categorical slots from the data-viz reference
 * palette, in their documented order. They are assigned by position and never
 * cycled: a chart needing a ninth series folds the tail into "Other" instead.
 */
export const SERIES_LIGHT = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const;

/**
 * Semantic colours for direction, kept strictly apart from the series slots.
 *
 * Green-up / red-down is the one place this app leans on the finance
 * convention, and it is exactly the pair colour-vision deficiency erases — so
 * it never travels alone. Every use pairs it with an arrow glyph and an
 * explicit sign, which is what actually carries the meaning; the colour only
 * reinforces it. That is also why income and expenses are drawn in the neutral
 * *series* slots on charts rather than green and red: on a line chart there is
 * no arrow to fall back on.
 */
export const DIRECTION = {
  positive: { light: '#008300', dark: '#22a922' },
  negative: { light: '#e34948', dark: '#e66767' },
  neutral: { light: '#52514e', dark: '#c3c2b7' },
} as const;

export const SERIES_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

export function seriesColor(index: number, mode: 'light' | 'dark'): string {
  const palette = mode === 'dark' ? SERIES_DARK : SERIES_LIGHT;
  // Clamp rather than wrap: a repeated hue would say "same entity" about two
  // different things, which is worse than running out of colours.
  return palette[Math.min(index, palette.length - 1)] ?? palette[0];
}

/**
 * Guards the seeded category palette against accessibility regressions.
 *
 * The colours in DEFAULT_CATEGORIES were selected by search and verified with a
 * colour-vision validator: no two adjacent hues may be confusable under
 * deuteranopia or protanopia, and none may be confusable under normal vision.
 *
 * This matters because the original hand-picked palette failed badly — two of
 * its greens scored ΔE 6.3 to *full-colour* vision, which is to say they were
 * the same colour on a chart. Recolouring a category is a one-line change that
 * looks harmless in review, so the property is enforced here instead.
 *
 * Thresholds match the data-viz method: OKLab ΔE ×100, CVD floor 8, normal
 * vision floor 15.
 */
import { DEFAULT_CATEGORIES } from '../packages/shared/dist/index.js';

const CVD_FLOOR = 8;
const NORMAL_FLOOR = 15;

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function hexToOklab(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(n.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Brettel-style LMS simulation, sufficient for a pass/fail gate. */
function simulate(hex, type) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(n.slice(i, i + 2), 16) / 255));
  let L = 0.31399022 * r + 0.63951294 * g + 0.04649755 * b;
  let M = 0.15537241 * r + 0.75789446 * g + 0.08670142 * b;
  let S = 0.01775239 * r + 0.10944209 * g + 0.87256922 * b;

  if (type === 'protan') L = 1.05118294 * M - 0.05116099 * S;
  else if (type === 'deutan') M = 0.9513092 * L + 0.04866992 * S;
  else S = -0.86744736 * L + 1.86727089 * M;

  const toHex = (v) => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0');
  };
  return `#${toHex(5.47221206 * L - 4.6419601 * M + 0.16963708 * S)}${toHex(
    -1.1252419 * L + 2.29317094 * M - 0.1678952 * S,
  )}${toHex(0.02980165 * L - 0.19318073 * M + 1.16364789 * S)}`;
}

const deltaE = (a, b) => {
  const [l1, a1, b1] = hexToOklab(a);
  const [l2, a2, b2] = hexToOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
};

// Miscellaneous is an intentional neutral for the "everything else" bucket and
// is exempt: it is never the only cue, because chips carry a name and an icon.
const colours = DEFAULT_CATEGORIES.filter((c) => c.slug !== 'miscellaneous').map((c) => c.color);

let failed = false;
let worstCvd = Infinity;
let worstNormal = Infinity;

for (let i = 1; i < colours.length; i += 1) {
  const [a, b] = [colours[i - 1], colours[i]];

  const normal = deltaE(a, b);
  worstNormal = Math.min(worstNormal, normal);
  if (normal < NORMAL_FLOOR) {
    console.error(`FAIL normal vision: ${a} vs ${b} — ΔE ${normal.toFixed(1)} < ${NORMAL_FLOOR}`);
    failed = true;
  }

  for (const type of ['protan', 'deutan']) {
    const d = deltaE(simulate(a, type), simulate(b, type));
    worstCvd = Math.min(worstCvd, d);
    if (d < CVD_FLOOR) {
      console.error(`FAIL ${type}: ${a} vs ${b} — ΔE ${d.toFixed(1)} < ${CVD_FLOOR}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\nCategory palette regressed. Re-run the data-viz validator before changing colours.');
  process.exit(1);
}

console.log(
  `Category palette OK — worst adjacent ΔE: ${worstCvd.toFixed(1)} (CVD, floor ${CVD_FLOOR}), ` +
    `${worstNormal.toFixed(1)} (normal, floor ${NORMAL_FLOOR}).`,
);

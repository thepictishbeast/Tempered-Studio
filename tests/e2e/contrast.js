// WCAG 2.x contrast for specs that check colours axe can't (gradient stops, a
// CodeMirror selection, a status dot). Inputs are computed-style colour strings.
const lum = (c) => c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
  .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
/** Contrast ratio of two opaque colours ("rgb(…)"; any alpha is ignored). */
const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** The colour stops of a computed background-image, in order. */
const stops = (image) => image.match(/rgba?\([^)]*\)/g) || [];
/** `top` (an "rgba(…)" may be translucent) composited over the opaque `base`. */
const over = (top, base) => {
  const t = top.match(/[\d.]+/g).map(Number), b = rgb(base), a = t.length > 3 ? t[3] : 1;
  return `rgb(${t.slice(0, 3).map((v, i) => v * a + b[i] * (1 - a)).join(', ')})`;
};

module.exports = { ratio, stops, over };

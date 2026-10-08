// Rate limit shared by the keyboard and step input modes: values move away from neutral
// gradually, but towards neutral at once. A command can therefore always be cut instantly,
// and never jumps up.

/** Next value on the way from `out` to `target`, moving away from zero by at most maxStep. */
export function approach(out, target, maxStep) {
  if (out !== 0 && Math.sign(target) !== Math.sign(out)) out = 0;   // drop through neutral first
  if (Math.abs(target) <= Math.abs(out)) return target;
  return out + Math.max(-maxStep, Math.min(maxStep, target - out));
}

const CODES = { SAVE10: 0.1, HALF: 0.5 };

export function applyDiscount(cents, code) {
  if (!code) return cents;
  const rate = CODES[code];
  if (rate === undefined) throw new Error(`Unknown discount code ${code}`);
  return Math.round(cents * (1 - rate));
}
